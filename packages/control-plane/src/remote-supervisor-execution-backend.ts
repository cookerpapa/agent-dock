import {
  AgentDockWireProtocolError,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type CancelTurnCommandMessage,
  type CommandAckMessage,
  type CommandCommitMessage,
  type CommandReleaseMessage,
  type CommandResultMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import {
  TurnCancellationBackendError,
  type TurnCancellationBackend,
  type TurnCancellationLifecycle,
  type TurnCancellationRequest,
  type TurnCancellationResult,
} from "./run-cancellation-executor.ts";
import {
  TurnExecutionBackendError,
  TurnExecutionCancelledError,
  type TurnExecutionBackend,
  type TurnExecutionLifecycle,
  type TurnExecutionRequest,
  type TurnExecutionResult,
} from "./run-command-executor.ts";
import {
  SessionLeaseCoordinator,
  SessionLeaseCoordinatorError,
} from "./session-lease-coordinator.ts";
import {
  SupervisorCommandTransportError,
  type RemoteSupervisorCommandTransport,
} from "./supervisor-command-router.ts";

type SupervisorCommand = ExecuteTurnCommandMessage | CancelTurnCommandMessage;

type RemoteSupervisorExecutionBackendCommonOptions = {
  sandboxId: string;
  transport: RemoteSupervisorCommandTransport;
  agentId?: string;
  clock?: () => Date;
  idGenerator?: () => string;
};

export type RemoteSupervisorExecutionBackendOptions =
  RemoteSupervisorExecutionBackendCommonOptions &
    (
      | {
          leaseCoordinator: SessionLeaseCoordinator;
          leaseCoordinatorProvider?: never;
        }
      | {
          leaseCoordinator?: never;
          leaseCoordinatorProvider: () =>
            SessionLeaseCoordinator | Promise<SessionLeaseCoordinator>;
        }
    );

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("remote supervisor backend clock must return a valid Date");
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

function sameCommandIdentity(
  command: SupervisorCommand,
  value: {
    commandId: string;
    sessionId: string;
    turnId: string;
    leaseId: string;
    fencingToken: number;
  },
): boolean {
  return (
    value.commandId === command.payload.commandId &&
    value.sessionId === command.payload.sessionId &&
    value.turnId === command.payload.turnId &&
    value.leaseId === command.payload.leaseId &&
    value.fencingToken === command.payload.fencingToken
  );
}

function acceptedAcknowledgement(command: SupervisorCommand, value: unknown): CommandAckMessage {
  const parsed = parseSupervisorToControlMessage(value);
  if (parsed.type !== "command.ack" || !sameCommandIdentity(command, parsed.payload)) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Supervisor command acknowledgement identity did not match",
      false,
    );
  }
  return parsed;
}

function disposition(
  type: "command.commit" | "command.release",
  command: SupervisorCommand,
  acknowledgement: CommandAckMessage,
  clock: () => Date,
  idGenerator: () => string,
): CommandCommitMessage | CommandReleaseMessage {
  const parsed = parseControlToSupervisorMessage({
    protocolVersion: 1,
    messageId: idGenerator(),
    sentAt: validDate(clock).toISOString(),
    type,
    payload: {
      commandId: command.payload.commandId,
      sessionId: command.payload.sessionId,
      turnId: command.payload.turnId,
      leaseId: command.payload.leaseId,
      fencingToken: command.payload.fencingToken,
      acknowledgedMessageId: acknowledgement.messageId,
    },
  });
  if (parsed.type !== type) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Constructed command disposition was invalid",
      false,
    );
  }
  return parsed;
}

function normalizeExecutionError(
  error: unknown,
  durableStarted: boolean,
): TurnExecutionBackendError {
  if (error instanceof TurnExecutionBackendError) return error;
  if (error instanceof SessionLeaseCoordinatorError) {
    return new TurnExecutionBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof SupervisorCommandTransportError) {
    return new TurnExecutionBackendError(
      error.code,
      error.message,
      !durableStarted && error.retryable,
      durableStarted && error.ambiguous,
    );
  }
  if (error instanceof AgentDockWireProtocolError) {
    return new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Remote supervisor wire protocol validation failed",
      false,
    );
  }
  return new TurnExecutionBackendError(
    "remote_supervisor_error",
    "Remote supervisor execution failed",
    !durableStarted,
    durableStarted,
  );
}

function normalizeCancellationError(
  error: unknown,
  durableStarted: boolean,
): TurnCancellationBackendError {
  if (error instanceof TurnCancellationBackendError) return error;
  if (error instanceof SessionLeaseCoordinatorError) {
    return new TurnCancellationBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof SupervisorCommandTransportError) {
    return new TurnCancellationBackendError(
      error.code,
      error.message,
      !durableStarted && error.retryable,
    );
  }
  if (error instanceof AgentDockWireProtocolError) {
    return new TurnCancellationBackendError(
      "backend_protocol_violation",
      "Remote supervisor cancellation protocol validation failed",
      false,
    );
  }
  return new TurnCancellationBackendError(
    "remote_supervisor_error",
    "Remote supervisor cancellation failed",
    !durableStarted,
  );
}

export class RemoteSupervisorExecutionBackend
  implements TurnExecutionBackend, TurnCancellationBackend
{
  readonly #sandboxId: string;
  readonly #transport: RemoteSupervisorCommandTransport;
  readonly #leaseCoordinatorProvider: () =>
    SessionLeaseCoordinator | Promise<SessionLeaseCoordinator>;
  readonly #agentId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: RemoteSupervisorExecutionBackendOptions) {
    this.#sandboxId = nonEmpty(options.sandboxId, "sandboxId");
    this.#transport = options.transport;
    if (
      (options.leaseCoordinator === undefined) ===
      (options.leaseCoordinatorProvider === undefined)
    ) {
      throw new TypeError(
        "exactly one of leaseCoordinator or leaseCoordinatorProvider must be configured",
      );
    }
    this.#leaseCoordinatorProvider =
      options.leaseCoordinatorProvider ?? (() => options.leaseCoordinator);
    this.#agentId = nonEmpty(options.agentId ?? "root", "agentId");
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
  ): Promise<TurnExecutionResult> {
    let leaseCoordinator: SessionLeaseCoordinator | undefined;
    let lease: { leaseId: string; fencingToken: number } | undefined;
    let command: ExecuteTurnCommandMessage | undefined;
    let acknowledgement: CommandAckMessage | undefined;
    let durableStarted = false;
    try {
      leaseCoordinator = await this.#leaseCoordinatorProvider();
      lease = await leaseCoordinator.acquire(request);
      command = this.#executeCommand(request, lease);
      acknowledgement = acceptedAcknowledgement(
        command,
        await this.#transport.prepare(this.#sandboxId, command),
      );
      if (acknowledgement.payload.status === "rejected") {
        throw new TurnExecutionBackendError(
          acknowledgement.payload.code,
          acknowledgement.payload.message,
          acknowledgement.payload.retryable,
        );
      }

      await lifecycle.started(lease);
      durableStarted = true;
      const commit = disposition(
        "command.commit",
        command,
        acknowledgement,
        this.#clock,
        this.#idGenerator,
      );
      if (commit.type !== "command.commit") {
        throw new TurnExecutionBackendError(
          "backend_protocol_violation",
          "Constructed execute commit was invalid",
          false,
        );
      }
      const result = await this.#transport.commit(
        this.#sandboxId,
        command,
        acknowledgement,
        commit,
      );
      return this.#executionResult(command, commit, result);
    } catch (error: unknown) {
      if (!durableStarted) {
        if (
          command !== undefined &&
          acknowledgement !== undefined &&
          acknowledgement.payload.status !== "rejected"
        ) {
          const release = disposition(
            "command.release",
            command,
            acknowledgement,
            this.#clock,
            this.#idGenerator,
          );
          if (release.type === "command.release") {
            await this.#transport
              .release(this.#sandboxId, command, acknowledgement, release)
              .catch(() => undefined);
          }
        }
        if (lease !== undefined && leaseCoordinator !== undefined) {
          await leaseCoordinator.releaseAcquired(request, lease).catch(() => undefined);
        }
      }
      throw normalizeExecutionError(error, durableStarted);
    }
  }

  async cancel(
    request: TurnCancellationRequest,
    lifecycle: TurnCancellationLifecycle,
  ): Promise<TurnCancellationResult> {
    let leaseCoordinator: SessionLeaseCoordinator | undefined;
    let command: CancelTurnCommandMessage | undefined;
    let acknowledgement: CommandAckMessage | undefined;
    let durableStarted = false;
    try {
      leaseCoordinator = await this.#leaseCoordinatorProvider();
      const lease = await leaseCoordinator.currentAssignment(request.target);
      command = this.#cancellationCommand(request, lease);
      acknowledgement = acceptedAcknowledgement(
        command,
        await this.#transport.prepare(this.#sandboxId, command),
      );
      if (acknowledgement.payload.status === "rejected") {
        throw new TurnCancellationBackendError(
          acknowledgement.payload.code,
          acknowledgement.payload.message,
          acknowledgement.payload.retryable,
        );
      }

      await lifecycle.started(lease);
      durableStarted = true;
      const commit = disposition(
        "command.commit",
        command,
        acknowledgement,
        this.#clock,
        this.#idGenerator,
      );
      if (commit.type !== "command.commit") {
        throw new TurnCancellationBackendError(
          "backend_protocol_violation",
          "Constructed cancellation commit was invalid",
          false,
        );
      }
      const result = await this.#transport.commit(
        this.#sandboxId,
        command,
        acknowledgement,
        commit,
      );
      return this.#cancellationResult(command, commit, result);
    } catch (error: unknown) {
      if (
        !durableStarted &&
        command !== undefined &&
        acknowledgement !== undefined &&
        acknowledgement.payload.status !== "rejected"
      ) {
        const release = disposition(
          "command.release",
          command,
          acknowledgement,
          this.#clock,
          this.#idGenerator,
        );
        if (release.type === "command.release") {
          await this.#transport
            .release(this.#sandboxId, command, acknowledgement, release)
            .catch(() => undefined);
        }
      }
      if (
        durableStarted &&
        leaseCoordinator !== undefined &&
        error instanceof SupervisorCommandTransportError &&
        error.ambiguous
      ) {
        await leaseCoordinator.quarantineSandbox().catch(() => undefined);
      }
      throw normalizeCancellationError(error, durableStarted);
    }
  }

  #executeCommand(
    request: TurnExecutionRequest,
    lease: { leaseId: string; fencingToken: number },
  ): ExecuteTurnCommandMessage {
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
        agentId: this.#agentId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
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
        environment: request.environment,
        ...(request.budgets === undefined ? {} : { budgets: request.budgets }),
        ...(request.traceContext === undefined ? {} : { traceContext: request.traceContext }),
      },
    });
    if (parsed.type !== "command.turn.execute") {
      throw new TurnExecutionBackendError(
        "backend_protocol_violation",
        "Constructed remote execute command was invalid",
        false,
      );
    }
    return parsed;
  }

  #cancellationCommand(
    request: TurnCancellationRequest,
    lease: { leaseId: string; fencingToken: number },
  ): CancelTurnCommandMessage {
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
        agentId: this.#agentId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        reason: request.reason,
        gracePeriodMs: request.gracePeriodMs,
      },
    });
    if (parsed.type !== "command.turn.cancel") {
      throw new TurnCancellationBackendError(
        "backend_protocol_violation",
        "Constructed remote cancellation command was invalid",
        false,
      );
    }
    return parsed;
  }

  #executionResult(
    command: ExecuteTurnCommandMessage,
    commit: CommandCommitMessage,
    value: unknown,
  ): TurnExecutionResult {
    const result = parseSupervisorToControlMessage(value);
    if (
      result.type !== "command.result" ||
      !sameCommandIdentity(command, result.payload) ||
      result.payload.commitMessageId !== commit.messageId ||
      result.payload.commandKind !== "turn.execute"
    ) {
      throw new TurnExecutionBackendError(
        "backend_protocol_violation",
        "Remote execute result identity did not match",
        false,
        true,
      );
    }
    if (result.payload.status === "failed") {
      throw new TurnExecutionBackendError(
        result.payload.code,
        result.payload.message,
        result.payload.retryable,
        result.payload.code === "lease_revoked",
      );
    }
    if (result.payload.status === "cancelled") {
      throw new TurnExecutionCancelledError(result.payload.reason, result.payload.forced);
    }
    return {
      stopReason: result.payload.stopReason,
      ...(result.payload.workspacePatch === undefined
        ? {}
        : { workspacePatch: result.payload.workspacePatch }),
    };
  }

  #cancellationResult(
    command: CancelTurnCommandMessage,
    commit: CommandCommitMessage,
    value: unknown,
  ): TurnCancellationResult {
    const result = parseSupervisorToControlMessage(value) as CommandResultMessage;
    if (
      result.type !== "command.result" ||
      !sameCommandIdentity(command, result.payload) ||
      result.payload.commitMessageId !== commit.messageId ||
      result.payload.commandKind !== "turn.cancel"
    ) {
      throw new TurnCancellationBackendError(
        "backend_protocol_violation",
        "Remote cancellation result identity did not match",
        false,
      );
    }
    if (result.payload.status === "failed") {
      throw new TurnCancellationBackendError(
        result.payload.code,
        result.payload.message,
        result.payload.retryable,
      );
    }
    if (result.payload.status !== "completed") {
      throw new TurnCancellationBackendError(
        "backend_protocol_violation",
        "Remote cancellation returned an invalid result",
        false,
      );
    }
    return { reason: result.payload.reason, forced: result.payload.forced };
  }
}
