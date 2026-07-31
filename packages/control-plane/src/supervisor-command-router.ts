import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  TWO_PHASE_COMMAND_CAPABILITY,
  PI_STEER_CAPABILITY,
  type CancelTurnCommandMessage,
  type CommandAckMessage,
  type CommandCommitMessage,
  type CommandReleaseMessage,
  type CommandResultMessage,
  type EventPublishMessage,
  type EventPublishBatchMessage,
  type ExecuteTurnCommandMessage,
  type SteerTurnCommandMessage,
  type SupervisorToControlMessage,
} from "@agent-dock/protocol";
import type { DurableEventIngestor } from "@agent-dock/runtime-core/durable-event-store";

export { TWO_PHASE_COMMAND_CAPABILITY };

const DEFAULT_COMMAND_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_RESULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING_COMMANDS = 1_000;

export type SupervisorRemoteCommand =
  ExecuteTurnCommandMessage | CancelTurnCommandMessage | SteerTurnCommandMessage;
type SupervisorEventPublication = EventPublishMessage | EventPublishBatchMessage;

export type SupervisorCommandConnection = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
  connectionId: string;
  capabilities: readonly string[];
  send(message: unknown): Promise<void>;
  assertEventAuthority(message: EventPublishMessage): Promise<void>;
};

export interface RemoteSupervisorCommandTransport {
  prepare(sandboxId: string, command: SupervisorRemoteCommand): Promise<CommandAckMessage>;
  commit(
    sandboxId: string,
    command: SupervisorRemoteCommand,
    acknowledgement: CommandAckMessage,
    commit: CommandCommitMessage,
  ): Promise<CommandResultMessage>;
  release(
    sandboxId: string,
    command: SupervisorRemoteCommand,
    acknowledgement: CommandAckMessage,
    release: CommandReleaseMessage,
  ): Promise<void>;
}

export type SupervisorCommandRouterOptions = {
  eventIngestor: DurableEventIngestor;
  onEvent?: (
    message: EventPublishMessage,
    connection: SupervisorCommandConnection,
  ) => Promise<void> | void;
  commandAckTimeoutMs?: number;
  commandResultTimeoutMs?: number;
  maxPendingCommands?: number;
};

export class SupervisorCommandTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean, ambiguous = false) {
    super(safeMessage);
    this.name = "SupervisorCommandTransportError";
    this.code = code;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}

type PendingAcknowledgement = {
  command: SupervisorRemoteCommand;
  resolve: (message: CommandAckMessage) => void;
  reject: (error: SupervisorCommandTransportError) => void;
  timer: NodeJS.Timeout;
};

type PreparedCommand = {
  command: SupervisorRemoteCommand;
  acknowledgement: CommandAckMessage;
};

type PendingResult = {
  command: SupervisorRemoteCommand;
  acknowledgement: CommandAckMessage;
  commit: CommandCommitMessage;
  resolve: (message: CommandResultMessage) => void;
  reject: (error: SupervisorCommandTransportError) => void;
  timer: NodeJS.Timeout;
};

type ConnectionState = {
  connection: SupervisorCommandConnection;
  capabilities: ReadonlySet<string>;
  pendingAcknowledgements: Map<string, PendingAcknowledgement>;
  preparedCommands: Map<string, PreparedCommand>;
  pendingResults: Map<string, PendingResult>;
  detached: boolean;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function sameCommandIdentity(
  command: SupervisorRemoteCommand,
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

function commandKind(
  command: SupervisorRemoteCommand,
): "turn.execute" | "turn.cancel" | "turn.steer" {
  if (command.type === "command.turn.execute") return "turn.execute";
  if (command.type === "command.turn.cancel") return "turn.cancel";
  return "turn.steer";
}

function pendingCount(state: ConnectionState): number {
  return (
    state.pendingAcknowledgements.size + state.preparedCommands.size + state.pendingResults.size
  );
}

function transportError(
  code: string,
  message: string,
  retryable: boolean,
  ambiguous = false,
): SupervisorCommandTransportError {
  return new SupervisorCommandTransportError(code, message, retryable, ambiguous);
}

export class SupervisorCommandRouter implements RemoteSupervisorCommandTransport {
  readonly #eventIngestor: DurableEventIngestor;
  readonly #onEvent:
    | ((
        message: EventPublishMessage,
        connection: SupervisorCommandConnection,
      ) => Promise<void> | void)
    | undefined;
  readonly #commandAckTimeoutMs: number;
  readonly #commandResultTimeoutMs: number;
  readonly #maxPendingCommands: number;
  readonly #bySandbox = new Map<string, ConnectionState>();
  readonly #byConnection = new WeakMap<SupervisorCommandConnection, ConnectionState>();

  constructor(options: SupervisorCommandRouterOptions) {
    this.#eventIngestor = options.eventIngestor;
    this.#onEvent = options.onEvent;
    this.#commandAckTimeoutMs = positiveInteger(
      options.commandAckTimeoutMs ?? DEFAULT_COMMAND_ACK_TIMEOUT_MS,
      "commandAckTimeoutMs",
    );
    this.#commandResultTimeoutMs = positiveInteger(
      options.commandResultTimeoutMs ?? DEFAULT_COMMAND_RESULT_TIMEOUT_MS,
      "commandResultTimeoutMs",
    );
    this.#maxPendingCommands = positiveInteger(
      options.maxPendingCommands ?? DEFAULT_MAX_PENDING_COMMANDS,
      "maxPendingCommands",
    );
  }

  get activeConnectionCount(): number {
    return this.#bySandbox.size;
  }

  attach(connection: SupervisorCommandConnection): void {
    if (this.#byConnection.has(connection)) {
      throw new SupervisorCommandTransportError(
        "connection_already_attached",
        "Supervisor command connection was already attached",
        false,
      );
    }
    const prior = this.#bySandbox.get(connection.sandboxId);
    if (prior !== undefined) {
      this.#detachState(
        prior,
        transportError(
          "connection_superseded",
          "Supervisor command connection was superseded",
          true,
          true,
        ),
      );
    }
    const state: ConnectionState = {
      connection,
      capabilities: new Set(connection.capabilities),
      pendingAcknowledgements: new Map(),
      preparedCommands: new Map(),
      pendingResults: new Map(),
      detached: false,
    };
    this.#bySandbox.set(connection.sandboxId, state);
    this.#byConnection.set(connection, state);
  }

  detach(connection: SupervisorCommandConnection): void {
    const state = this.#byConnection.get(connection);
    if (state === undefined || state.detached) return;
    this.#detachState(
      state,
      transportError("connection_closed", "Supervisor command connection closed", true, true),
    );
  }

  async receive(
    connection: SupervisorCommandConnection,
    message: SupervisorToControlMessage,
  ): Promise<boolean> {
    const state = this.#byConnection.get(connection);
    if (
      state === undefined ||
      state.detached ||
      this.#bySandbox.get(connection.sandboxId) !== state
    ) {
      throw transportError(
        "stale_connection",
        "Supervisor command message came from a stale connection",
        false,
        true,
      );
    }
    if (message.type === "command.ack") {
      this.#acceptAcknowledgement(state, message);
      return true;
    }
    if (message.type === "command.result") {
      this.#acceptResult(state, message);
      return true;
    }
    if (message.type === "event.publish" || message.type === "event.publish_batch") {
      const publications: EventPublishMessage[] =
        message.type === "event.publish"
          ? [message]
          : message.payload.events.map((event) => ({
              protocolVersion: 1,
              messageId: message.messageId,
              sentAt: message.sentAt,
              type: "event.publish",
              payload: {
                leaseId: message.payload.leaseId,
                fencingToken: message.payload.fencingToken,
                ...(message.payload.commandId === undefined
                  ? {}
                  : { commandId: message.payload.commandId }),
                event,
              },
            }));
      const lastEvent =
        message.type === "event.publish" ? message.payload.event : message.payload.events.at(-1)!;
      await connection.assertEventAuthority(publications[0]!);
      const acknowledgement = await this.#eventIngestor.ingest(message);
      const parsed = parseControlToSupervisorMessage(acknowledgement);
      if (
        parsed.type !== "event.ack" ||
        parsed.payload.sessionId !== lastEvent.sessionId ||
        parsed.payload.leaseId !== message.payload.leaseId ||
        parsed.payload.fencingToken !== message.payload.fencingToken ||
        parsed.payload.acknowledgedThroughSeq !== lastEvent.seq
      ) {
        throw transportError(
          "event_ack_mismatch",
          "Durable event acknowledgement did not match its publication",
          false,
          true,
        );
      }
      for (const publication of publications) {
        await this.#onEvent?.(publication, connection);
      }
      await connection.send(parsed);
      return true;
    }
    return false;
  }

  async prepare(sandboxId: string, value: SupervisorRemoteCommand): Promise<CommandAckMessage> {
    const parsed = parseControlToSupervisorMessage(value);
    if (
      parsed.type !== "command.turn.execute" &&
      parsed.type !== "command.turn.cancel" &&
      parsed.type !== "command.turn.steer"
    ) {
      throw transportError(
        "invalid_command",
        "Remote transport only prepares execute, cancellation, or steer commands",
        false,
      );
    }
    const state = this.#connection(sandboxId, false);
    if (parsed.type === "command.turn.steer" && !state.capabilities.has(PI_STEER_CAPABILITY)) {
      throw transportError(
        "supervisor_capability_missing",
        "Supervisor does not support Pi steer",
        false,
      );
    }
    const commandId = parsed.payload.commandId;
    if (
      state.pendingAcknowledgements.has(commandId) ||
      state.preparedCommands.has(commandId) ||
      state.pendingResults.has(commandId)
    ) {
      throw transportError(
        "command_exchange_conflict",
        "Command already has an exchange on this connection",
        false,
      );
    }
    if (pendingCount(state) >= this.#maxPendingCommands) {
      throw transportError(
        "command_transport_capacity",
        "Supervisor command transport is at capacity",
        true,
      );
    }

    let pending!: PendingAcknowledgement;
    const acknowledgement = new Promise<CommandAckMessage>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (state.pendingAcknowledgements.get(commandId) !== pending) return;
        state.pendingAcknowledgements.delete(commandId);
        rejectPromise(
          transportError(
            "command_ack_timeout",
            "Supervisor command acknowledgement timed out",
            true,
          ),
        );
      }, this.#commandAckTimeoutMs);
      timer.unref();
      pending = {
        command: parsed,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      };
      state.pendingAcknowledgements.set(commandId, pending);
    });

    try {
      await state.connection.send(parsed);
    } catch {
      if (state.pendingAcknowledgements.get(commandId) === pending) {
        clearTimeout(pending.timer);
        state.pendingAcknowledgements.delete(commandId);
        pending.reject(
          transportError("command_send_failed", "Supervisor command could not be sent", true),
        );
      }
    }
    return acknowledgement;
  }

  async commit(
    sandboxId: string,
    commandValue: SupervisorRemoteCommand,
    acknowledgementValue: CommandAckMessage,
    commitValue: CommandCommitMessage,
  ): Promise<CommandResultMessage> {
    const command = this.#parseCommand(commandValue);
    const acknowledgement = this.#parseAcceptedAcknowledgement(acknowledgementValue);
    const commit = parseControlToSupervisorMessage(commitValue);
    if (commit.type !== "command.commit") {
      throw transportError("invalid_commit", "Remote command commit was invalid", false, true);
    }
    const state = this.#connection(sandboxId, true);
    const prepared = state.preparedCommands.get(command.payload.commandId);
    if (
      prepared === undefined ||
      prepared.command.messageId !== command.messageId ||
      prepared.acknowledgement.messageId !== acknowledgement.messageId ||
      !sameCommandIdentity(command, acknowledgement.payload) ||
      !sameCommandIdentity(command, commit.payload) ||
      commit.payload.acknowledgedMessageId !== acknowledgement.messageId
    ) {
      throw transportError(
        "command_commit_mismatch",
        "Command commit did not match its prepared acknowledgement",
        false,
        true,
      );
    }
    if (state.pendingResults.has(command.payload.commandId)) {
      throw transportError(
        "command_exchange_conflict",
        "Command result is already pending",
        false,
        true,
      );
    }

    let pending!: PendingResult;
    const result = new Promise<CommandResultMessage>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (state.pendingResults.get(command.payload.commandId) !== pending) return;
        state.pendingResults.delete(command.payload.commandId);
        rejectPromise(
          transportError(
            "command_result_timeout",
            "Supervisor command result timed out",
            false,
            true,
          ),
        );
      }, this.#commandResultTimeoutMs);
      timer.unref();
      pending = {
        command,
        acknowledgement,
        commit,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      };
      state.preparedCommands.delete(command.payload.commandId);
      state.pendingResults.set(command.payload.commandId, pending);
    });

    try {
      await state.connection.send(commit);
    } catch {
      if (state.pendingResults.get(command.payload.commandId) === pending) {
        clearTimeout(pending.timer);
        state.pendingResults.delete(command.payload.commandId);
        pending.reject(
          transportError(
            "command_commit_send_failed",
            "Supervisor command commit could not be sent",
            false,
            true,
          ),
        );
      }
    }
    return result;
  }

  async release(
    sandboxId: string,
    commandValue: SupervisorRemoteCommand,
    acknowledgementValue: CommandAckMessage,
    releaseValue: CommandReleaseMessage,
  ): Promise<void> {
    const command = this.#parseCommand(commandValue);
    const acknowledgement = this.#parseAcceptedAcknowledgement(acknowledgementValue);
    const release = parseControlToSupervisorMessage(releaseValue);
    if (release.type !== "command.release") {
      throw transportError("invalid_release", "Remote command release was invalid", false);
    }
    const state = this.#connection(sandboxId, false);
    const prepared = state.preparedCommands.get(command.payload.commandId);
    if (
      prepared === undefined ||
      prepared.command.messageId !== command.messageId ||
      prepared.acknowledgement.messageId !== acknowledgement.messageId ||
      !sameCommandIdentity(command, acknowledgement.payload) ||
      !sameCommandIdentity(command, release.payload) ||
      release.payload.acknowledgedMessageId !== acknowledgement.messageId
    ) {
      throw transportError(
        "command_release_mismatch",
        "Command release did not match its prepared acknowledgement",
        false,
      );
    }
    await state.connection.send(release);
    state.preparedCommands.delete(command.payload.commandId);
  }

  #connection(sandboxId: string, ambiguous: boolean): ConnectionState {
    const state = this.#bySandbox.get(sandboxId);
    if (state === undefined || state.detached) {
      throw transportError(
        "supervisor_connection_unavailable",
        "Supervisor command connection is unavailable",
        !ambiguous,
        ambiguous,
      );
    }
    if (!state.capabilities.has(TWO_PHASE_COMMAND_CAPABILITY)) {
      throw transportError(
        "supervisor_capability_missing",
        "Supervisor does not support two-phase commands",
        false,
        ambiguous,
      );
    }
    return state;
  }

  #parseCommand(value: SupervisorRemoteCommand): SupervisorRemoteCommand {
    const parsed = parseControlToSupervisorMessage(value);
    if (
      parsed.type !== "command.turn.execute" &&
      parsed.type !== "command.turn.cancel" &&
      parsed.type !== "command.turn.steer"
    ) {
      throw transportError("invalid_command", "Remote command was invalid", false);
    }
    return parsed;
  }

  #parseAcceptedAcknowledgement(value: CommandAckMessage): CommandAckMessage {
    const parsed = parseSupervisorToControlMessage(value);
    if (parsed.type !== "command.ack" || parsed.payload.status === "rejected") {
      throw transportError(
        "invalid_command_ack",
        "Remote command acknowledgement was not accepted",
        false,
      );
    }
    return parsed;
  }

  #acceptAcknowledgement(state: ConnectionState, message: CommandAckMessage): void {
    const pending = state.pendingAcknowledgements.get(message.payload.commandId);
    if (pending === undefined) {
      throw transportError(
        "unexpected_command_ack",
        "Supervisor sent an unexpected command acknowledgement",
        false,
      );
    }
    if (!sameCommandIdentity(pending.command, message.payload)) {
      throw transportError(
        "command_ack_mismatch",
        "Supervisor command acknowledgement identity did not match",
        false,
      );
    }
    clearTimeout(pending.timer);
    state.pendingAcknowledgements.delete(message.payload.commandId);
    if (message.payload.status !== "rejected") {
      state.preparedCommands.set(message.payload.commandId, {
        command: pending.command,
        acknowledgement: message,
      });
    }
    pending.resolve(message);
  }

  #acceptResult(state: ConnectionState, message: CommandResultMessage): void {
    const pending = state.pendingResults.get(message.payload.commandId);
    if (pending === undefined) {
      throw transportError(
        "unexpected_command_result",
        "Supervisor sent an unexpected command result",
        false,
        true,
      );
    }
    if (
      !sameCommandIdentity(pending.command, message.payload) ||
      message.payload.commitMessageId !== pending.commit.messageId ||
      message.payload.commandKind !== commandKind(pending.command)
    ) {
      throw transportError(
        "command_result_mismatch",
        "Supervisor command result identity did not match",
        false,
        true,
      );
    }
    clearTimeout(pending.timer);
    state.pendingResults.delete(message.payload.commandId);
    pending.resolve(message);
  }

  #detachState(state: ConnectionState, error: SupervisorCommandTransportError): void {
    if (state.detached) return;
    state.detached = true;
    if (this.#bySandbox.get(state.connection.sandboxId) === state) {
      this.#bySandbox.delete(state.connection.sandboxId);
    }
    for (const pending of state.pendingAcknowledgements.values()) {
      clearTimeout(pending.timer);
      pending.reject(transportError(error.code, error.message, error.retryable, false));
    }
    for (const pending of state.pendingResults.values()) {
      clearTimeout(pending.timer);
      pending.reject(transportError(error.code, error.message, false, true));
    }
    state.pendingAcknowledgements.clear();
    state.preparedCommands.clear();
    state.pendingResults.clear();
  }
}
