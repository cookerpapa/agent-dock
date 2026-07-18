import {
  LocalSandboxSupervisor,
  LocalSandboxSupervisorError,
  PiRpcTurnError,
} from "@agent-dock/sandbox-supervisor";
import {
  AgentDockWireProtocolError,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import {
  TurnExecutionBackendError,
  type TurnExecutionBackend,
  type TurnExecutionLifecycle,
  type TurnExecutionRequest,
  type TurnExecutionResult,
} from "./outbox-dispatcher.ts";
import { DurableEventStoreError, type DurableEventIngestor } from "./durable-event-store.ts";
import {
  SessionLeaseCoordinator,
  SessionLeaseCoordinatorError,
} from "./session-lease-coordinator.ts";

export type LocalSupervisorExecutionBackendOptions = {
  supervisor: LocalSandboxSupervisor;
  leaseCoordinator: SessionLeaseCoordinator;
  eventIngestor: DurableEventIngestor;
  onEvent?: (message: EventPublishMessage) => Promise<void> | void;
  clock?: () => Date;
  idGenerator?: () => string;
};

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("local supervisor backend clock must return a valid Date");
  }
  return value;
}

function positiveSafeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      `${name} is outside the wire protocol range`,
      false,
    );
  }
  return parsed;
}

function normalizeBackendError(error: unknown): TurnExecutionBackendError {
  if (error instanceof TurnExecutionBackendError) return error;
  if (error instanceof SessionLeaseCoordinatorError || error instanceof PiRpcTurnError) {
    return new TurnExecutionBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof DurableEventStoreError) {
    return new TurnExecutionBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof LocalSandboxSupervisorError) {
    return new TurnExecutionBackendError(error.code, error.message, false);
  }
  if (error instanceof AgentDockWireProtocolError) {
    return new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Supervisor wire protocol validation failed",
      false,
    );
  }
  return new TurnExecutionBackendError(
    "local_supervisor_error",
    "Local supervisor execution failed",
    true,
  );
}

function validateEventAck(eventMessage: EventPublishMessage, value: unknown): EventAckMessage {
  const parsed = parseControlToSupervisorMessage(value);
  if (
    parsed.type !== "event.ack" ||
    parsed.payload.sessionId !== eventMessage.payload.event.sessionId ||
    parsed.payload.leaseId !== eventMessage.payload.leaseId ||
    parsed.payload.fencingToken !== eventMessage.payload.fencingToken ||
    parsed.payload.acknowledgedThroughSeq !== eventMessage.payload.event.seq
  ) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Event ACK identity does not match the published event",
      false,
    );
  }
  return parsed;
}

function validateAck(
  request: TurnExecutionRequest,
  command: ExecuteTurnCommandMessage,
  value: unknown,
) {
  const parsed = parseSupervisorToControlMessage(value);
  if (parsed.type !== "command.ack") {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Supervisor returned a non-ACK message",
      false,
    );
  }
  if (
    parsed.payload.commandId !== request.commandId ||
    parsed.payload.sessionId !== request.sessionId ||
    parsed.payload.turnId !== request.turnId ||
    parsed.payload.leaseId !== command.payload.leaseId ||
    parsed.payload.fencingToken !== command.payload.fencingToken
  ) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Supervisor ACK identity does not match the delivered command",
      false,
    );
  }
  return parsed;
}

export class LocalSupervisorExecutionBackend implements TurnExecutionBackend {
  readonly #supervisor: LocalSandboxSupervisor;
  readonly #leaseCoordinator: SessionLeaseCoordinator;
  readonly #eventIngestor: DurableEventIngestor;
  readonly #onEvent: ((message: EventPublishMessage) => Promise<void> | void) | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: LocalSupervisorExecutionBackendOptions) {
    this.#supervisor = options.supervisor;
    this.#leaseCoordinator = options.leaseCoordinator;
    this.#eventIngestor = options.eventIngestor;
    this.#onEvent = options.onEvent;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
  ): Promise<TurnExecutionResult> {
    let acknowledgement:
      | {
          leaseId: string;
          fencingToken: number;
        }
      | undefined;
    let prepared: ReturnType<LocalSandboxSupervisor["prepare"]> | undefined;
    let durableStarted = false;

    try {
      acknowledgement = await this.#leaseCoordinator.acquire(request);
      const parsed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "command.turn.execute",
        payload: {
          commandId: request.commandId,
          idempotencyKey: request.idempotencyKey,
          tenantId: request.tenantId,
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          agentId: "root",
          leaseId: acknowledgement.leaseId,
          fencingToken: acknowledgement.fencingToken,
          nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
          input: { kind: "prompt", text: request.input.prompt },
          model: {
            profileId: request.model.profileId,
            provider: request.model.provider,
            modelId: request.model.modelId,
            thinkingLevel: request.model.thinkingLevel,
            credentialBindingId: request.model.credentialBindingId,
            credentialBindingVersion: positiveSafeInteger(
              request.model.credentialBindingVersion,
              "credential binding version",
            ),
          },
        },
      });
      if (parsed.type !== "command.turn.execute") {
        throw new TurnExecutionBackendError(
          "backend_protocol_violation",
          "Constructed supervisor command was invalid",
          false,
        );
      }
      const command = parsed;
      prepared = this.#supervisor.prepare(command, async (message) => {
        const eventMessage = parseSupervisorToControlMessage(message);
        if (
          eventMessage.type !== "event.publish" ||
          eventMessage.payload.commandId !== request.commandId ||
          eventMessage.payload.leaseId !== acknowledgement?.leaseId ||
          eventMessage.payload.fencingToken !== acknowledgement.fencingToken ||
          eventMessage.payload.event.sessionId !== request.sessionId ||
          eventMessage.payload.event.turnId !== request.turnId
        ) {
          throw new TurnExecutionBackendError(
            "backend_protocol_violation",
            "Supervisor event identity does not match the running command",
            false,
          );
        }
        const eventAck = validateEventAck(
          eventMessage,
          await this.#eventIngestor.ingest(eventMessage),
        );
        await this.#onEvent?.(eventMessage);
        return eventAck;
      });
      const ack = validateAck(request, command, prepared.ack);
      if (ack.payload.status === "rejected") {
        throw new TurnExecutionBackendError(
          ack.payload.code,
          ack.payload.message,
          ack.payload.retryable,
        );
      }

      await lifecycle.started(acknowledgement);
      durableStarted = true;
      return await prepared.run();
    } catch (error: unknown) {
      if (!durableStarted) {
        prepared?.releaseBeforeStart();
        if (acknowledgement !== undefined) {
          await this.#leaseCoordinator.releaseAcquired(request, acknowledgement).catch(() => {
            // Preserve the original delivery error. The durable lease expires and
            // will be fenced by the next acquisition if cleanup also failed.
          });
        }
      }
      throw normalizeBackendError(error);
    }
  }
}
