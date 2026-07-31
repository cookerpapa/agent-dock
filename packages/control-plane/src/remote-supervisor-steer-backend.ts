import {
  AgentDockWireProtocolError,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type CommandAckMessage,
  type CommandCommitMessage,
  type CommandReleaseMessage,
  type SteerTurnCommandMessage,
} from "@agent-dock/protocol";
import {
  SessionLeaseCoordinator,
  SessionLeaseCoordinatorError,
} from "@agent-dock/runtime-core/session-lease-coordinator";
import {
  WorkerControlChannelError,
  type RemoteWorkerControlTransport,
} from "./worker-control-channel.ts";
import {
  TurnSteerBackendError,
  type TurnSteerBackend,
  type TurnSteerRequest,
} from "./turn-steer.ts";

type RemoteSupervisorSteerBackendCommonOptions = {
  sandboxId: string;
  transport: RemoteWorkerControlTransport;
  agentId?: string;
  clock?: () => Date;
  idGenerator?: () => string;
};

export type RemoteSupervisorSteerBackendOptions = RemoteSupervisorSteerBackendCommonOptions &
  (
    | {
        leaseCoordinator: SessionLeaseCoordinator;
        leaseCoordinatorProvider?: never;
      }
    | {
        leaseCoordinator?: never;
        leaseCoordinatorProvider: () => SessionLeaseCoordinator | Promise<SessionLeaseCoordinator>;
      }
  );

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("remote supervisor steer clock must return a valid Date");
  }
  return value;
}

function sameCommandIdentity(
  command: SteerTurnCommandMessage,
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

function normalizeSteerError(error: unknown, committed: boolean): TurnSteerBackendError {
  if (error instanceof TurnSteerBackendError) return error;
  if (error instanceof SessionLeaseCoordinatorError) {
    return new TurnSteerBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof WorkerControlChannelError) {
    return new TurnSteerBackendError(
      error.code,
      error.message,
      !committed && error.retryable,
      committed && error.ambiguous,
    );
  }
  if (error instanceof AgentDockWireProtocolError) {
    return new TurnSteerBackendError(
      "backend_protocol_violation",
      "Remote supervisor steer protocol validation failed",
      false,
      committed,
    );
  }
  return new TurnSteerBackendError(
    "remote_supervisor_error",
    "Remote supervisor steer failed",
    !committed,
    committed,
  );
}

/**
 * The Supervisor WebSocket is a Worker control channel. Run execution and
 * cancellation are owned by Temporal Activities and the local runtime; only
 * an in-flight steer needs to cross this channel.
 */
export class RemoteSupervisorSteerBackend implements TurnSteerBackend {
  readonly #sandboxId: string;
  readonly #transport: RemoteWorkerControlTransport;
  readonly #leaseCoordinatorProvider: () =>
    SessionLeaseCoordinator | Promise<SessionLeaseCoordinator>;
  readonly #agentId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: RemoteSupervisorSteerBackendOptions) {
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

  async steer(request: TurnSteerRequest): Promise<void> {
    let command: SteerTurnCommandMessage | undefined;
    let acknowledgement: CommandAckMessage | undefined;
    let committed = false;
    try {
      const leaseCoordinator = await this.#leaseCoordinatorProvider();
      const lease = await leaseCoordinator.currentAssignment(request.target);
      command = this.#command(request, lease);
      acknowledgement = this.#acceptedAcknowledgement(
        command,
        await this.#transport.prepare(this.#sandboxId, command),
      );
      if (acknowledgement.payload.status === "rejected") {
        throw new TurnSteerBackendError(
          acknowledgement.payload.code,
          acknowledgement.payload.message,
          acknowledgement.payload.retryable,
        );
      }

      const commit = this.#disposition("command.commit", command, acknowledgement);
      if (commit.type !== "command.commit") {
        throw new TurnSteerBackendError(
          "backend_protocol_violation",
          "Constructed steer commit was invalid",
          false,
        );
      }
      committed = true;
      const result = parseSupervisorToControlMessage(
        await this.#transport.commit(this.#sandboxId, command, acknowledgement, commit),
      );
      if (
        result.type !== "command.result" ||
        !sameCommandIdentity(command, result.payload) ||
        result.payload.commitMessageId !== commit.messageId ||
        result.payload.commandKind !== "turn.steer"
      ) {
        throw new TurnSteerBackendError(
          "backend_protocol_violation",
          "Remote steer result identity did not match",
          false,
          true,
        );
      }
      if (result.payload.status === "failed") {
        throw new TurnSteerBackendError(
          result.payload.code,
          result.payload.message,
          result.payload.retryable,
        );
      }
      if (result.payload.status !== "completed") {
        throw new TurnSteerBackendError(
          "backend_protocol_violation",
          "Remote steer returned an invalid result",
          false,
          true,
        );
      }
    } catch (error: unknown) {
      if (
        !committed &&
        command !== undefined &&
        acknowledgement !== undefined &&
        acknowledgement.payload.status !== "rejected"
      ) {
        const release = this.#disposition("command.release", command, acknowledgement);
        if (release.type === "command.release") {
          await this.#transport
            .release(this.#sandboxId, command, acknowledgement, release)
            .catch(() => undefined);
        }
      }
      throw normalizeSteerError(error, committed);
    }
  }

  #command(
    request: TurnSteerRequest,
    lease: { leaseId: string; fencingToken: number },
  ): SteerTurnCommandMessage {
    const parsed = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: validDate(this.#clock).toISOString(),
      type: "command.turn.steer",
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
        text: request.text,
      },
    });
    if (parsed.type !== "command.turn.steer") {
      throw new TurnSteerBackendError(
        "backend_protocol_violation",
        "Constructed remote steer command was invalid",
        false,
      );
    }
    return parsed;
  }

  #acceptedAcknowledgement(command: SteerTurnCommandMessage, value: unknown): CommandAckMessage {
    const parsed = parseSupervisorToControlMessage(value);
    if (parsed.type !== "command.ack" || !sameCommandIdentity(command, parsed.payload)) {
      throw new TurnSteerBackendError(
        "backend_protocol_violation",
        "Supervisor steer acknowledgement identity did not match",
        false,
      );
    }
    return parsed;
  }

  #disposition(
    type: "command.commit" | "command.release",
    command: SteerTurnCommandMessage,
    acknowledgement: CommandAckMessage,
  ): CommandCommitMessage | CommandReleaseMessage {
    const parsed = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: validDate(this.#clock).toISOString(),
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
      throw new TurnSteerBackendError(
        "backend_protocol_violation",
        "Constructed steer disposition was invalid",
        false,
      );
    }
    return parsed;
  }
}
