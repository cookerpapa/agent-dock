import {
  LocalSandboxSupervisor,
  LocalSandboxSupervisorError,
  PiRpcTurnCancelledError,
  PiRpcTurnError,
} from "@agent-dock/sandbox-supervisor";
import {
  AgentDockWireProtocolError,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type CancelTurnCommandMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import {
  TurnCancellationBackendError,
  type TurnCancellationBackend,
  type TurnCancellationLifecycle,
  type TurnCancellationRequest,
  type TurnCancellationResult,
} from "./cancellation-dispatcher.ts";
import {
  TurnExecutionBackendError,
  TurnExecutionCancelledError,
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
  heartbeatIntervalMs?: number;
};

type TrackedLeaseExecution = {
  prepared: ReturnType<LocalSandboxSupervisor["prepare"]>;
  execution: Promise<TurnExecutionResult>;
  failure?: TurnExecutionBackendError;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    const onAbort = (): void => settle();
    function settle(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
  if (error instanceof PiRpcTurnCancelledError) {
    if (error.reason === "lease_revoked") {
      return new TurnExecutionBackendError(
        "lease_revoked",
        "Execution lease was revoked and the runtime was stopped",
        false,
        true,
      );
    }
    return new TurnExecutionCancelledError(error.reason, error.forced);
  }
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

function normalizeCancellationError(error: unknown): TurnCancellationBackendError {
  if (error instanceof TurnCancellationBackendError) return error;
  if (error instanceof SessionLeaseCoordinatorError || error instanceof PiRpcTurnError) {
    return new TurnCancellationBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof LocalSandboxSupervisorError) {
    return new TurnCancellationBackendError(error.code, error.message, false);
  }
  if (error instanceof AgentDockWireProtocolError) {
    return new TurnCancellationBackendError(
      "backend_protocol_violation",
      "Supervisor wire protocol validation failed",
      false,
    );
  }
  return new TurnCancellationBackendError(
    "local_supervisor_error",
    "Local supervisor cancellation failed",
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

function validateCancellationAck(
  request: TurnCancellationRequest,
  command: CancelTurnCommandMessage,
  value: unknown,
) {
  const parsed = parseSupervisorToControlMessage(value);
  if (parsed.type !== "command.ack") {
    throw new TurnCancellationBackendError(
      "backend_protocol_violation",
      "Supervisor returned a non-ACK cancellation response",
      false,
    );
  }
  if (
    parsed.payload.commandId !== request.commandId ||
    parsed.payload.sessionId !== request.target.sessionId ||
    parsed.payload.turnId !== request.target.turnId ||
    parsed.payload.leaseId !== command.payload.leaseId ||
    parsed.payload.fencingToken !== command.payload.fencingToken
  ) {
    throw new TurnCancellationBackendError(
      "backend_protocol_violation",
      "Supervisor cancellation ACK identity does not match the delivered command",
      false,
    );
  }
  return parsed;
}

export class LocalSupervisorExecutionBackend
  implements TurnExecutionBackend, TurnCancellationBackend
{
  readonly #supervisor: LocalSandboxSupervisor;
  readonly #leaseCoordinator: SessionLeaseCoordinator;
  readonly #eventIngestor: DurableEventIngestor;
  readonly #onEvent: ((message: EventPublishMessage) => Promise<void> | void) | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #heartbeatIntervalMs: number;
  readonly #trackedExecutions = new Map<string, TrackedLeaseExecution>();
  #heartbeatAbort: AbortController | undefined;
  #heartbeatTask: Promise<void> | undefined;
  #heartbeatFailure: TurnExecutionBackendError | undefined;

  constructor(options: LocalSupervisorExecutionBackendOptions) {
    this.#supervisor = options.supervisor;
    this.#leaseCoordinator = options.leaseCoordinator;
    this.#eventIngestor = options.eventIngestor;
    this.#onEvent = options.onEvent;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? this.#leaseCoordinator.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    );
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
          runId: request.runId,
          turnId: request.turnId,
          attemptId: request.attemptId,
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
          ...(request.budgets === undefined ? {} : { budgets: request.budgets }),
          ...(request.traceContext === undefined ? {} : { traceContext: request.traceContext }),
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
        const publications =
          eventMessage.type === "event.publish"
            ? [eventMessage]
            : eventMessage.type === "event.publish_batch"
              ? eventMessage.payload.events.map((event) => ({
                  protocolVersion: 1 as const,
                  messageId: eventMessage.messageId,
                  sentAt: eventMessage.sentAt,
                  type: "event.publish" as const,
                  payload: {
                    leaseId: eventMessage.payload.leaseId,
                    fencingToken: eventMessage.payload.fencingToken,
                    ...(eventMessage.payload.commandId === undefined
                      ? {}
                      : { commandId: eventMessage.payload.commandId }),
                    event,
                  },
                }))
              : [];
        if (
          publications.length === 0 ||
          publications.some(
            (publication) =>
              publication.payload.commandId !== request.commandId ||
              publication.payload.leaseId !== acknowledgement?.leaseId ||
              publication.payload.fencingToken !== acknowledgement.fencingToken ||
              publication.payload.event.sessionId !== request.sessionId ||
              publication.payload.event.turnId !== request.turnId,
          )
        ) {
          throw new TurnExecutionBackendError(
            "backend_protocol_violation",
            "Supervisor event identity does not match the running command",
            false,
          );
        }
        const last = publications.at(-1)!;
        const eventAck = validateEventAck(last, await this.#eventIngestor.ingest(eventMessage));
        for (const publication of publications) await this.#onEvent?.(publication);
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
      const execution = prepared.run();
      const tracked = this.#registerLeaseExecution(request.sessionId, prepared, execution);
      try {
        let result: TurnExecutionResult;
        try {
          result = await execution;
        } catch (error: unknown) {
          if (tracked.failure !== undefined) throw tracked.failure;
          throw error;
        }
        if (tracked.failure !== undefined) throw tracked.failure;
        return result;
      } finally {
        await this.#unregisterLeaseExecution(request.sessionId, tracked);
      }
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

  async cancel(
    request: TurnCancellationRequest,
    lifecycle: TurnCancellationLifecycle,
  ): Promise<TurnCancellationResult> {
    try {
      const acknowledgement = await this.#leaseCoordinator.currentAssignment(request.target);
      const parsed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "command.turn.cancel",
        payload: {
          commandId: request.commandId,
          targetCommandId: request.target.commandId,
          idempotencyKey: request.idempotencyKey,
          tenantId: request.target.tenantId,
          projectId: request.target.projectId,
          workspaceId: request.target.workspaceId,
          sessionId: request.target.sessionId,
          runId: request.target.runId,
          turnId: request.target.turnId,
          attemptId: request.target.attemptId,
          agentId: "root",
          leaseId: acknowledgement.leaseId,
          fencingToken: acknowledgement.fencingToken,
          reason: request.reason,
          gracePeriodMs: request.gracePeriodMs,
        },
      });
      if (parsed.type !== "command.turn.cancel") {
        throw new TurnCancellationBackendError(
          "backend_protocol_violation",
          "Constructed supervisor cancellation command was invalid",
          false,
        );
      }
      const command = parsed;
      const prepared = this.#supervisor.prepareCancellation(command);
      const ack = validateCancellationAck(request, command, prepared.ack);
      if (ack.payload.status === "rejected") {
        throw new TurnCancellationBackendError(
          ack.payload.code,
          ack.payload.message,
          ack.payload.retryable,
        );
      }

      await lifecycle.started(acknowledgement);
      return await prepared.run();
    } catch (error: unknown) {
      throw normalizeCancellationError(error);
    }
  }

  #registerLeaseExecution(
    sessionId: string,
    prepared: ReturnType<LocalSandboxSupervisor["prepare"]>,
    execution: Promise<TurnExecutionResult>,
  ): TrackedLeaseExecution {
    const tracked: TrackedLeaseExecution = { prepared, execution };
    if (this.#trackedExecutions.has(sessionId)) {
      tracked.failure = new TurnExecutionBackendError(
        "lease_monitor_invariant",
        "Session already had a tracked lease execution",
        false,
        true,
      );
      prepared.revokeLease();
      return tracked;
    }
    this.#trackedExecutions.set(sessionId, tracked);
    if (this.#heartbeatFailure !== undefined) {
      tracked.failure = this.#heartbeatFailure;
      prepared.revokeLease();
    } else {
      this.#startHeartbeatTask();
    }
    return tracked;
  }

  async #unregisterLeaseExecution(
    sessionId: string,
    tracked: TrackedLeaseExecution,
  ): Promise<void> {
    if (this.#trackedExecutions.get(sessionId) === tracked) {
      this.#trackedExecutions.delete(sessionId);
    }
    if (this.#trackedExecutions.size !== 0) return;
    this.#heartbeatAbort?.abort();
    await this.#heartbeatTask;
  }

  #startHeartbeatTask(): void {
    if (this.#heartbeatTask !== undefined || this.#heartbeatFailure !== undefined) return;
    const abort = new AbortController();
    this.#heartbeatAbort = abort;
    const task = this.#runHeartbeatTask(abort.signal).finally(() => {
      if (this.#heartbeatTask === task) {
        this.#heartbeatTask = undefined;
        this.#heartbeatAbort = undefined;
        if (this.#trackedExecutions.size > 0 && this.#heartbeatFailure === undefined) {
          this.#startHeartbeatTask();
        }
      }
    });
    this.#heartbeatTask = task;
  }

  async #runHeartbeatTask(signal: AbortSignal): Promise<void> {
    try {
      const identity = await this.#leaseCoordinator.heartbeatIdentity();
      while (!signal.aborted && this.#trackedExecutions.size > 0) {
        const heartbeat = this.#supervisor.createHeartbeat(identity);
        const result = this.#supervisor.applyHeartbeatAcknowledgement(
          heartbeat,
          await this.#leaseCoordinator.renewFromHeartbeat(heartbeat),
        );
        if (result.revokedAssignments !== result.revokedSessionIds.length) {
          throw new LocalSandboxSupervisorError(
            "invalid_heartbeat_result",
            "Supervisor heartbeat result was internally inconsistent",
          );
        }
        for (const sessionId of result.revokedSessionIds) {
          const tracked = this.#trackedExecutions.get(sessionId);
          if (tracked !== undefined) tracked.failure = this.#leaseRenewalFailure();
        }
        await wait(this.#heartbeatIntervalMs, signal);
      }
    } catch {
      if (signal.aborted) return;
      const failure = this.#leaseRenewalFailure();
      this.#heartbeatFailure = failure;
      await this.#leaseCoordinator.quarantineSandbox().catch(() => undefined);
      const trackedExecutions = [...this.#trackedExecutions.values()];
      for (const tracked of trackedExecutions) {
        tracked.failure = failure;
        tracked.prepared.revokeLease();
      }
      await Promise.allSettled(trackedExecutions.map((tracked) => tracked.execution));
    }
  }

  #leaseRenewalFailure(): TurnExecutionBackendError {
    return new TurnExecutionBackendError(
      "lease_renewal_failed",
      "Execution lease renewal failed and the runtime was revoked",
      false,
      true,
    );
  }
}
