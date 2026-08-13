import {
  TWO_PHASE_COMMAND_CAPABILITY,
  PI_STEER_CAPABILITY,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type CommandAckMessage,
  type CommandCommitMessage,
  type CommandReleaseMessage,
  type CommandResultMessage,
  type EventAckMessage,
  type EventPublishBatchMessage,
  type EventPublishMessage,
  type EventRejectedMessage,
  type SteerTurnCommandMessage,
  type SupervisorHeartbeatAckMessage,
  type SupervisorHeartbeatMessage,
  type SupervisorRegisteredMessage,
} from "@agent-dock/protocol";
import WebSocket, { type RawData } from "ws";
import type { PreparedTurnSteer } from "./local-sandbox-supervisor.ts";
import type { SupervisorEventSpoolRecoveryResult } from "./in-memory-event-spool.ts";
import { EventDeliveryRejectedError } from "./in-memory-event-spool.ts";
import { PINNED_PI_CODING_AGENT_VERSION } from "./pi-turn-runtime.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_EVENT_ACK_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_FRAMES = 16;

export interface SupervisorHeartbeatRuntime {
  createHeartbeat(
    identity: { supervisorId: string; bootId: string; connectionId: string },
    acceptingAssignments?: boolean,
  ): SupervisorHeartbeatMessage;
  applyHeartbeatAcknowledgement(
    heartbeat: SupervisorHeartbeatMessage,
    acknowledgement: SupervisorHeartbeatAckMessage,
  ): unknown;
}

export interface SupervisorControlRuntime extends SupervisorHeartbeatRuntime {
  prepareSteer(value: unknown): PreparedTurnSteer;
  revokeAllAssignments(): unknown;
  recoverPendingEvents?(
    publishEvent: (message: EventPublishMessage) => Promise<EventAckMessage>,
  ): Promise<SupervisorEventSpoolRecoveryResult>;
}

export type SupervisorWebSocketRegistration = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
  supervisorVersion?: string;
  piPackageName?: string;
  piVersion?: string;
  supportedProtocolVersions?: readonly number[];
  capabilities?: readonly string[];
  maxConcurrentSessions: number;
};

export type SupervisorWebSocketClientOptions = {
  url: string;
  authorizationHeader: string;
  registration: SupervisorWebSocketRegistration;
  runtime: SupervisorControlRuntime;
  clock?: () => Date;
  idGenerator?: () => string;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  eventAckTimeoutMs?: number;
  maxPayloadBytes?: number;
  maxPendingFrames?: number;
  maxBufferedSendBytes?: number;
  /**
   * A retryable Control Channel break is not an execution-ownership loss when
   * the Run renews its PostgreSQL lease through the Worker execution path.
   * Standalone clients keep the historical fail-closed default; the
   * reconnecting production client explicitly suspends transport revocation.
   */
  revokeRuntimeOnRetryableDisconnect?: boolean;
};

export type SupervisorWebSocketClientClose = {
  initiatedByClient: boolean;
  code: number;
  reason: string;
  retryable: boolean;
  failureCode?: string;
};

export class SupervisorWebSocketClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorWebSocketClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

type ClientState = "idle" | "connecting" | "registered" | "failing" | "stopping" | "closed";

type PendingHeartbeat = {
  message: SupervisorHeartbeatMessage;
  timeout: NodeJS.Timeout;
};

type PendingEventAcknowledgement = {
  message: EventPublishMessage | EventPublishBatchMessage;
  resolve: (acknowledgement: EventAckMessage) => void;
  reject: (error: SupervisorWebSocketClientError | EventDeliveryRejectedError) => void;
  timeout: NodeJS.Timeout;
};

type RemotePreparedSteer = {
  kind: "turn.steer";
  command: SteerTurnCommandMessage;
  acknowledgement: CommandAckMessage;
  prepared: PreparedTurnSteer;
  committed: boolean;
};

type RemotePreparedCommand = RemotePreparedSteer;

type SafeCommandFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("supervisor WebSocket client clock must return a valid Date");
  }
  return value;
}

function websocketUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password) {
    throw new TypeError("supervisor WebSocket URL must use ws/wss without embedded credentials");
  }
  if (url.hash) throw new TypeError("supervisor WebSocket URL must not contain a fragment");
  if (url.search) throw new TypeError("supervisor WebSocket URL must not contain a query");
  return url.toString();
}

function textFrame(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function retryableWebSocketClose(code: number): boolean {
  return (
    code === 1_001 ||
    code === 1_006 ||
    code === 1_011 ||
    code === 1_012 ||
    code === 1_013 ||
    code === 4_002
  );
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

function normalizedFailure(error: unknown): SafeCommandFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(error.code)
  ) {
    return {
      code: error.code,
      message:
        error instanceof Error
          ? error.message.slice(0, 4_096) || "Supervisor steer failed"
          : "Supervisor steer failed",
      retryable: false,
    };
  }
  return {
    code: "supervisor_steer_failed",
    message: "Supervisor steer failed",
    retryable: true,
  };
}

export class SupervisorWebSocketClient {
  readonly #url: string;
  readonly #authorizationHeader: string;
  readonly #registration: Required<SupervisorWebSocketRegistration>;
  readonly #runtime: SupervisorControlRuntime;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #connectTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #eventAckTimeoutMs: number;
  readonly #maxPayloadBytes: number;
  readonly #maxPendingFrames: number;
  readonly #maxBufferedSendBytes: number;
  readonly #revokeRuntimeOnRetryableDisconnect: boolean;
  readonly #closedPromise: Promise<SupervisorWebSocketClientClose>;
  readonly #resolveClosed: (value: SupervisorWebSocketClientClose) => void;
  readonly #preparedCommands = new Map<string, RemotePreparedCommand>();
  readonly #pendingEventAcknowledgements = new Map<string, PendingEventAcknowledgement>();
  readonly #commandTasks = new Set<Promise<void>>();
  #state: ClientState = "idle";
  #socket: WebSocket | undefined;
  #registered: SupervisorRegisteredMessage | undefined;
  #startResolve: ((message: SupervisorRegisteredMessage) => void) | undefined;
  #startReject: ((error: SupervisorWebSocketClientError) => void) | undefined;
  #connectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #pendingHeartbeat: PendingHeartbeat | undefined;
  #heartbeatRefreshRequested = false;
  #frameProcessing: Promise<void> = Promise.resolve();
  #pendingFrames = 0;
  #acceptingAssignments = true;
  #initiatedClose = false;
  #failureCode: string | undefined;
  #failureRetryable: boolean | undefined;
  #closedSettled = false;
  #transportInvalidated = false;
  #runtimeRevoked = false;

  constructor(options: SupervisorWebSocketClientOptions) {
    this.#url = websocketUrl(options.url);
    if (
      options.authorizationHeader.trim().length === 0 ||
      options.authorizationHeader.length > 4_103 ||
      /[\r\n]/.test(options.authorizationHeader)
    ) {
      throw new TypeError("authorizationHeader must be a bounded non-empty value");
    }
    this.#authorizationHeader = options.authorizationHeader;
    this.#registration = {
      supervisorId: nonEmpty(options.registration.supervisorId, "registration.supervisorId"),
      bootId: requireUuid(options.registration.bootId, "registration.bootId"),
      sandboxId: requireUuid(options.registration.sandboxId, "registration.sandboxId"),
      supervisorVersion: nonEmpty(
        options.registration.supervisorVersion ?? "0.1.0",
        "registration.supervisorVersion",
      ),
      piPackageName: nonEmpty(
        options.registration.piPackageName ?? "@earendil-works/pi-coding-agent",
        "registration.piPackageName",
      ),
      piVersion: nonEmpty(
        options.registration.piVersion ?? PINNED_PI_CODING_AGENT_VERSION,
        "registration.piVersion",
      ),
      supportedProtocolVersions: [...(options.registration.supportedProtocolVersions ?? [1])],
      capabilities: [
        ...(options.registration.capabilities ?? [
          "event.replay",
          "pi.sdk",
          PI_STEER_CAPABILITY,
          TWO_PHASE_COMMAND_CAPABILITY,
        ]),
      ],
      maxConcurrentSessions: positiveInteger(
        options.registration.maxConcurrentSessions,
        "registration.maxConcurrentSessions",
      ),
    };
    this.#runtime = options.runtime;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
    this.#closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      "closeTimeoutMs",
    );
    this.#eventAckTimeoutMs = positiveInteger(
      options.eventAckTimeoutMs ?? DEFAULT_EVENT_ACK_TIMEOUT_MS,
      "eventAckTimeoutMs",
    );
    this.#maxPayloadBytes = positiveInteger(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
    );
    this.#maxPendingFrames = positiveInteger(
      options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES,
      "maxPendingFrames",
    );
    this.#maxBufferedSendBytes = positiveInteger(
      options.maxBufferedSendBytes ?? this.#maxPayloadBytes,
      "maxBufferedSendBytes",
    );
    this.#revokeRuntimeOnRetryableDisconnect = options.revokeRuntimeOnRetryableDisconnect ?? true;
    let resolveClosed!: (value: SupervisorWebSocketClientClose) => void;
    this.#closedPromise = new Promise((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    this.#resolveClosed = resolveClosed;
  }

  get state(): ClientState {
    return this.#state;
  }

  get connectionId(): string | undefined {
    return this.#registered?.payload.connectionId;
  }

  setAcceptingAssignments(value: boolean): void {
    if (this.#acceptingAssignments === value) return;
    this.#acceptingAssignments = value;
    if (this.#state !== "registered") return;
    if (this.#pendingHeartbeat !== undefined) {
      this.#heartbeatRefreshRequested = true;
      return;
    }
    if (this.#heartbeatTimer !== undefined) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#scheduleHeartbeat(0);
  }

  async recoverPendingEvents(): Promise<SupervisorEventSpoolRecoveryResult> {
    if (this.#state !== "registered" || this.#registered === undefined) {
      throw new SupervisorWebSocketClientError(
        "invalid_client_state",
        "Pending event recovery requires a registered Supervisor connection",
        false,
      );
    }
    if (this.#acceptingAssignments) {
      throw new SupervisorWebSocketClientError(
        "invalid_client_state",
        "Pending event recovery requires assignment drain",
        false,
      );
    }
    if (this.#runtime.recoverPendingEvents === undefined) {
      return {
        scannedSpools: 0,
        replayedSpools: 0,
        replayedEvents: 0,
        quarantinedSpools: 0,
        quarantinedEvents: 0,
      };
    }
    try {
      return await this.#runtime.recoverPendingEvents((message) => this.#publishEvent(message));
    } catch (error: unknown) {
      const failure =
        error instanceof SupervisorWebSocketClientError
          ? error
          : new SupervisorWebSocketClientError(
              "event_spool_recovery_failed",
              "Pending Supervisor events could not be recovered",
              false,
            );
      this.#fail(failure.code, failure.message, failure.retryable);
      throw failure;
    }
  }

  waitUntilClosed(): Promise<SupervisorWebSocketClientClose> {
    return this.#closedPromise;
  }

  async start(): Promise<SupervisorRegisteredMessage> {
    if (this.#state !== "idle") {
      throw new SupervisorWebSocketClientError(
        "invalid_client_state",
        "Supervisor WebSocket client was already started",
        false,
      );
    }
    this.#state = "connecting";
    const started = new Promise<SupervisorRegisteredMessage>((resolvePromise, rejectPromise) => {
      this.#startResolve = resolvePromise;
      this.#startReject = rejectPromise;
    });
    const socket = new WebSocket(this.#url, {
      headers: { authorization: this.#authorizationHeader },
      handshakeTimeout: this.#connectTimeoutMs,
      maxPayload: this.#maxPayloadBytes,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    this.#connectTimer = setTimeout(() => {
      this.#fail("registration_timeout", "Supervisor registration timed out", true);
    }, this.#connectTimeoutMs);
    this.#connectTimer.unref();

    socket.once("open", () => {
      void this.#send(this.#registrationMessage()).catch(() => {
        this.#fail("registration_send_failed", "Supervisor registration send failed", true);
      });
    });
    socket.on("message", (data, isBinary) => {
      this.#enqueueFrame(data, isBinary);
    });
    socket.once("error", () => {
      this.#fail("websocket_transport_failed", "Supervisor WebSocket transport failed", true);
    });
    socket.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      if (statusCode === 401 || statusCode === 403) {
        this.#fail(
          "supervisor_authentication_rejected",
          "Supervisor WebSocket authentication was rejected",
          false,
        );
        return;
      }
      this.#fail(
        "websocket_handshake_rejected",
        "Supervisor WebSocket handshake was rejected",
        statusCode === 429 || statusCode >= 500,
      );
    });
    socket.once("close", (code, reason) => {
      this.#finishClose(code, reason.toString("utf8"));
    });
    return started;
  }

  async stop(): Promise<SupervisorWebSocketClientClose> {
    if (this.#state === "idle") {
      this.#initiatedClose = true;
      this.#revokeRuntime("Supervisor client stopped");
      this.#state = "closed";
      this.#settleClosed({
        initiatedByClient: true,
        code: 1_000,
        reason: "not started",
        retryable: false,
      });
      return this.#closedPromise;
    }
    if (this.#state === "closed" || this.#state === "failing") return this.#closedPromise;
    this.#initiatedClose = true;
    this.#startReject?.(
      new SupervisorWebSocketClientError(
        "supervisor_client_stopped",
        "Supervisor WebSocket client was stopped",
        false,
      ),
    );
    this.#startResolve = undefined;
    this.#startReject = undefined;
    this.#state = "stopping";
    this.#clearTimers();
    this.#revokeRuntime("Supervisor client stopped");
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.close(1_000, "client shutdown");
      const forceTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }, this.#closeTimeoutMs);
      forceTimer.unref();
    } else if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    } else {
      this.#finishClose(1_000, "client shutdown");
    }
    return this.#closedPromise;
  }

  #registrationMessage() {
    const parsed = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: requireUuid(this.#idGenerator(), "generated registration messageId"),
      sentAt: validDate(this.#clock).toISOString(),
      type: "supervisor.register",
      payload: {
        supervisorId: this.#registration.supervisorId,
        bootId: this.#registration.bootId,
        sandboxId: this.#registration.sandboxId,
        supervisorVersion: this.#registration.supervisorVersion,
        pi: {
          packageName: this.#registration.piPackageName,
          version: this.#registration.piVersion,
        },
        supportedProtocolVersions: this.#registration.supportedProtocolVersions,
        capabilities: this.#registration.capabilities,
        acceptingAssignments: this.#acceptingAssignments,
        maxConcurrentSessions: this.#registration.maxConcurrentSessions,
      },
    });
    if (parsed.type !== "supervisor.register") {
      throw new SupervisorWebSocketClientError(
        "registration_invariant",
        "Constructed supervisor registration is invalid",
        false,
      );
    }
    return parsed;
  }

  #enqueueFrame(data: RawData, isBinary: boolean): void {
    if (this.#state === "closed" || this.#state === "failing" || this.#state === "stopping") return;
    this.#pendingFrames += 1;
    if (this.#pendingFrames > this.#maxPendingFrames) {
      this.#pendingFrames -= 1;
      this.#fail("frame_queue_overloaded", "Supervisor client frame queue overloaded", true);
      return;
    }
    this.#frameProcessing = this.#frameProcessing
      .then(async () => {
        if (this.#state !== "closed" && this.#state !== "failing" && this.#state !== "stopping") {
          await this.#processFrame(data, isBinary);
        }
      })
      .catch((error: unknown) => {
        this.#handleProcessingError(error);
      })
      .finally(() => {
        this.#pendingFrames -= 1;
      });
  }

  async #processFrame(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      throw new SupervisorWebSocketClientError(
        "binary_frame",
        "Supervisor server sent a binary frame",
        false,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(textFrame(data));
    } catch {
      throw new SupervisorWebSocketClientError(
        "invalid_server_json",
        "Supervisor server sent invalid JSON",
        false,
      );
    }
    let message;
    try {
      message = parseControlToSupervisorMessage(value);
    } catch {
      throw new SupervisorWebSocketClientError(
        "invalid_server_message",
        "Supervisor server sent an invalid message",
        false,
      );
    }

    if (this.#state === "connecting") {
      if (
        message.type !== "supervisor.registered" ||
        message.payload.supervisorId !== this.#registration.supervisorId ||
        message.payload.bootId !== this.#registration.bootId
      ) {
        throw new SupervisorWebSocketClientError(
          "registration_ack_mismatch",
          "Supervisor registration acknowledgement did not match",
          false,
        );
      }
      this.#registered = message;
      this.#state = "registered";
      if (this.#connectTimer !== undefined) {
        clearTimeout(this.#connectTimer);
        this.#connectTimer = undefined;
      }
      this.#startResolve?.(message);
      this.#startResolve = undefined;
      this.#startReject = undefined;
      this.#scheduleHeartbeat(0);
      return;
    }

    if (this.#state !== "registered") return;
    if (message.type === "supervisor.heartbeat.ack") {
      this.#acceptHeartbeatAcknowledgement(message);
      return;
    }
    if (message.type === "event.ack") {
      this.#acceptEventAcknowledgement(message);
      return;
    }
    if (message.type === "event.rejected") {
      this.#acceptEventRejection(message);
      return;
    }
    if (message.type === "command.turn.steer") {
      await this.#prepareCommand(message);
      return;
    }
    if (message.type === "command.commit") {
      this.#commitCommand(message);
      return;
    }
    if (message.type === "command.release") {
      this.#releaseCommand(message);
      return;
    }
    throw new SupervisorWebSocketClientError(
      "unexpected_server_message",
      "Supervisor server message was unexpected",
      false,
    );
  }

  #acceptHeartbeatAcknowledgement(message: SupervisorHeartbeatAckMessage): void {
    const pending = this.#pendingHeartbeat;
    if (
      pending === undefined ||
      message.payload.acknowledgedMessageId !== pending.message.messageId
    ) {
      throw new SupervisorWebSocketClientError(
        "unexpected_heartbeat_ack",
        "Supervisor heartbeat acknowledgement was unexpected",
        false,
      );
    }
    clearTimeout(pending.timeout);
    this.#pendingHeartbeat = undefined;
    try {
      this.#runtime.applyHeartbeatAcknowledgement(pending.message, message);
    } catch {
      throw new SupervisorWebSocketClientError(
        "heartbeat_ack_rejected",
        "Supervisor heartbeat acknowledgement was rejected",
        false,
      );
    }
    const refreshImmediately = this.#heartbeatRefreshRequested;
    this.#heartbeatRefreshRequested = false;
    this.#scheduleHeartbeat(refreshImmediately ? 0 : this.#registered!.payload.heartbeatIntervalMs);
  }

  async #prepareCommand(command: SteerTurnCommandMessage): Promise<void> {
    if (this.#preparedCommands.has(command.payload.commandId)) {
      throw new SupervisorWebSocketClientError(
        "command_exchange_conflict",
        "Supervisor command already has an active exchange",
        false,
      );
    }
    const prepared = this.#runtime.prepareSteer(command);
    const acknowledgement = this.#validateCommandAcknowledgement(command, prepared.ack);
    const entry: RemotePreparedCommand = {
      kind: "turn.steer",
      command,
      acknowledgement,
      prepared,
      committed: false,
    };
    if (entry.acknowledgement.payload.status !== "rejected") {
      this.#preparedCommands.set(command.payload.commandId, entry);
    }
    try {
      await this.#send(entry.acknowledgement);
    } catch (error: unknown) {
      if (entry.acknowledgement.payload.status !== "rejected") {
        entry.prepared.releaseBeforeStart();
        this.#preparedCommands.delete(command.payload.commandId);
      }
      throw error;
    }
  }

  #validateCommandAcknowledgement(
    command: SteerTurnCommandMessage,
    value: unknown,
  ): CommandAckMessage {
    const acknowledgement = parseSupervisorToControlMessage(value);
    if (
      acknowledgement.type !== "command.ack" ||
      !sameCommandIdentity(command, acknowledgement.payload)
    ) {
      throw new SupervisorWebSocketClientError(
        "command_ack_mismatch",
        "Prepared command acknowledgement identity did not match",
        false,
      );
    }
    return acknowledgement;
  }

  #commitCommand(commit: CommandCommitMessage): void {
    const entry = this.#preparedCommands.get(commit.payload.commandId);
    if (
      entry === undefined ||
      entry.committed ||
      !sameCommandIdentity(entry.command, commit.payload) ||
      commit.payload.acknowledgedMessageId !== entry.acknowledgement.messageId
    ) {
      throw new SupervisorWebSocketClientError(
        "command_commit_mismatch",
        "Command commit did not match an uncommitted preparation",
        false,
      );
    }
    entry.committed = true;
    let task!: Promise<void>;
    task = this.#runCommittedCommand(entry, commit)
      .catch((error: unknown) => {
        if (error instanceof SupervisorWebSocketClientError) {
          this.#fail(error.code, error.message, error.retryable);
        } else {
          this.#fail("command_result_send_failed", "Command result could not be sent", true);
        }
      })
      .finally(() => {
        this.#preparedCommands.delete(entry.command.payload.commandId);
        this.#commandTasks.delete(task);
      });
    this.#commandTasks.add(task);
  }

  async #runCommittedCommand(
    entry: RemotePreparedCommand,
    commit: CommandCommitMessage,
  ): Promise<void> {
    let result: CommandResultMessage;
    try {
      await entry.prepared.run();
      result = this.#commandResult(entry, commit, { status: "completed" });
    } catch (error: unknown) {
      result = this.#commandResult(entry, commit, {
        status: "failed",
        ...normalizedFailure(error),
      });
    }
    await this.#send(result);
  }

  #commandResult(
    entry: RemotePreparedCommand,
    commit: CommandCommitMessage,
    outcome: { status: "completed" } | ({ status: "failed" } & SafeCommandFailure),
  ): CommandResultMessage {
    const identity = {
      commandId: entry.command.payload.commandId,
      sessionId: entry.command.payload.sessionId,
      turnId: entry.command.payload.turnId,
      leaseId: entry.command.payload.leaseId,
      fencingToken: entry.command.payload.fencingToken,
      commitMessageId: commit.messageId,
      commandKind: entry.kind,
    };
    const parsed = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: requireUuid(this.#idGenerator(), "generated command result messageId"),
      sentAt: validDate(this.#clock).toISOString(),
      type: "command.result",
      payload: { ...identity, ...outcome },
    });
    if (parsed.type !== "command.result") {
      throw new SupervisorWebSocketClientError(
        "command_result_invariant",
        "Constructed supervisor command result was invalid",
        false,
      );
    }
    return parsed;
  }

  #releaseCommand(release: CommandReleaseMessage): void {
    const entry = this.#preparedCommands.get(release.payload.commandId);
    if (
      entry === undefined ||
      entry.committed ||
      !sameCommandIdentity(entry.command, release.payload) ||
      release.payload.acknowledgedMessageId !== entry.acknowledgement.messageId
    ) {
      throw new SupervisorWebSocketClientError(
        "command_release_mismatch",
        "Command release did not match an uncommitted preparation",
        false,
      );
    }
    entry.prepared.releaseBeforeStart();
    this.#preparedCommands.delete(release.payload.commandId);
  }

  async #publishEvent(
    value: EventPublishMessage | EventPublishBatchMessage,
  ): Promise<EventAckMessage> {
    const message = parseSupervisorToControlMessage(value);
    if (message.type !== "event.publish" && message.type !== "event.publish_batch") {
      throw new SupervisorWebSocketClientError(
        "invalid_event",
        "Supervisor runtime produced an invalid event publication",
        false,
      );
    }
    if (this.#state !== "registered") {
      throw new SupervisorWebSocketClientError(
        "event_transport_unavailable",
        "Supervisor event transport is unavailable",
        true,
      );
    }
    const lastEvent =
      message.type === "event.publish" ? message.payload.event : message.payload.events.at(-1)!;
    const sessionId = lastEvent.sessionId;
    if (this.#pendingEventAcknowledgements.has(sessionId)) {
      throw new SupervisorWebSocketClientError(
        "event_ack_overlap",
        "Session already has an event awaiting acknowledgement",
        false,
      );
    }
    let pending!: PendingEventAcknowledgement;
    const acknowledgement = new Promise<EventAckMessage>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        if (this.#pendingEventAcknowledgements.get(sessionId) !== pending) return;
        this.#pendingEventAcknowledgements.delete(sessionId);
        const error = new SupervisorWebSocketClientError(
          "event_ack_timeout",
          "Supervisor event acknowledgement timed out",
          true,
        );
        rejectPromise(error);
        this.#fail(error.code, error.message, error.retryable);
      }, this.#eventAckTimeoutMs);
      timeout.unref();
      pending = {
        message,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
      };
      this.#pendingEventAcknowledgements.set(sessionId, pending);
    });
    try {
      await this.#send(message);
    } catch (error: unknown) {
      if (this.#pendingEventAcknowledgements.get(sessionId) === pending) {
        clearTimeout(pending.timeout);
        this.#pendingEventAcknowledgements.delete(sessionId);
        pending.reject(
          error instanceof SupervisorWebSocketClientError
            ? error
            : new SupervisorWebSocketClientError(
                "event_send_failed",
                "Supervisor event could not be sent",
                true,
              ),
        );
      }
    }
    return acknowledgement;
  }

  #acceptEventAcknowledgement(message: EventAckMessage): void {
    const pending = this.#pendingEventAcknowledgements.get(message.payload.sessionId);
    const lastEvent =
      pending?.message.type === "event.publish"
        ? pending.message.payload.event
        : pending?.message.payload.events.at(-1);
    if (
      pending === undefined ||
      lastEvent === undefined ||
      message.payload.leaseId !== pending.message.payload.leaseId ||
      message.payload.fencingToken !== pending.message.payload.fencingToken ||
      message.payload.acknowledgedThroughSeq !== lastEvent.seq
    ) {
      throw new SupervisorWebSocketClientError(
        "event_ack_mismatch",
        "Supervisor event acknowledgement identity did not match",
        false,
      );
    }
    clearTimeout(pending.timeout);
    this.#pendingEventAcknowledgements.delete(message.payload.sessionId);
    pending.resolve(message);
  }

  #acceptEventRejection(message: EventRejectedMessage): void {
    const pending = this.#pendingEventAcknowledgements.get(message.payload.sessionId);
    const lastEvent =
      pending?.message.type === "event.publish"
        ? pending.message.payload.event
        : pending?.message.payload.events.at(-1);
    if (
      pending === undefined ||
      lastEvent === undefined ||
      message.payload.leaseId !== pending.message.payload.leaseId ||
      message.payload.fencingToken !== pending.message.payload.fencingToken ||
      message.payload.rejectedSeq !== lastEvent.seq
    ) {
      throw new SupervisorWebSocketClientError(
        "event_rejection_mismatch",
        "Supervisor event rejection identity did not match",
        false,
      );
    }
    clearTimeout(pending.timeout);
    this.#pendingEventAcknowledgements.delete(message.payload.sessionId);
    pending.reject(new EventDeliveryRejectedError(message));
  }

  #scheduleHeartbeat(delayMs: number): void {
    if (this.#state !== "registered") return;
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = undefined;
      void this.#sendHeartbeat();
    }, delayMs);
    this.#heartbeatTimer.unref();
  }

  async #sendHeartbeat(): Promise<void> {
    if (this.#state !== "registered" || this.#registered === undefined) return;
    if (this.#pendingHeartbeat !== undefined) {
      this.#fail("heartbeat_overlap", "Supervisor heartbeat overlapped", false);
      return;
    }
    let message: SupervisorHeartbeatMessage;
    try {
      message = this.#runtime.createHeartbeat(
        {
          supervisorId: this.#registration.supervisorId,
          bootId: this.#registration.bootId,
          connectionId: this.#registered.payload.connectionId,
        },
        this.#acceptingAssignments,
      );
    } catch {
      this.#fail("heartbeat_build_failed", "Supervisor heartbeat could not be built", false);
      return;
    }
    // Heartbeats are serialized and the next interval starts only after this ACK.
    // Giving the database-backed control plane merely one heartbeat interval to
    // reply makes healthy connections flap under short-lived write contention.
    // Keep enough time for one subsequent heartbeat before the durable liveness
    // deadline instead.
    const acknowledgementTimeoutMs = Math.max(
      1,
      this.#registered.payload.heartbeatTimeoutMs - this.#registered.payload.heartbeatIntervalMs,
    );
    const timeout = setTimeout(() => {
      this.#fail("heartbeat_ack_timeout", "Supervisor heartbeat acknowledgement timed out", true);
    }, acknowledgementTimeoutMs);
    timeout.unref();
    this.#pendingHeartbeat = { message, timeout };
    try {
      await this.#send(message);
    } catch {
      this.#fail("heartbeat_send_failed", "Supervisor heartbeat send failed", true);
    }
  }

  async #send(value: unknown): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new SupervisorWebSocketClientError(
        "websocket_not_open",
        "Supervisor WebSocket is not open",
        true,
      );
    }
    const payload = JSON.stringify(value);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (
      bytes > this.#maxPayloadBytes ||
      bytes > this.#maxBufferedSendBytes ||
      socket.bufferedAmount + bytes > this.#maxBufferedSendBytes
    ) {
      throw new SupervisorWebSocketClientError(
        "send_buffer_overloaded",
        "Supervisor WebSocket send buffer is overloaded",
        true,
      );
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.send(payload, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }

  #handleProcessingError(error: unknown): void {
    if (error instanceof SupervisorWebSocketClientError) {
      this.#fail(error.code, error.message, error.retryable);
      return;
    }
    this.#fail(
      "message_processing_failed",
      "Supervisor server message could not be processed",
      false,
    );
  }

  #fail(code: string, safeMessage: string, retryable: boolean): void {
    if (this.#state === "closed" || this.#state === "failing" || this.#state === "stopping") return;
    this.#failureCode = code;
    this.#failureRetryable = retryable;
    const error = new SupervisorWebSocketClientError(code, safeMessage, retryable);
    this.#startReject?.(error);
    this.#startResolve = undefined;
    this.#startReject = undefined;
    this.#state = "failing";
    this.#clearTimers();
    this.#invalidateTransport(safeMessage);
    if (!retryable || this.#revokeRuntimeOnRetryableDisconnect) {
      this.#revokeRuntime(safeMessage);
    }
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.close(retryable ? 1_011 : 1_002, "supervisor client failed");
    } else if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    } else {
      this.#finishClose(retryable ? 1_011 : 1_002, "supervisor client failed");
    }
  }

  #finishClose(code: number, reason: string): void {
    if (this.#state === "closed") return;
    const retryable =
      !this.#initiatedClose && (this.#failureRetryable ?? retryableWebSocketClose(code));
    if (this.#state === "connecting" && this.#startReject !== undefined) {
      this.#startReject(
        new SupervisorWebSocketClientError(
          this.#failureCode ?? "registration_connection_closed",
          "Supervisor connection closed before registration",
          retryable,
        ),
      );
      this.#startResolve = undefined;
      this.#startReject = undefined;
    }
    this.#clearTimers();
    this.#invalidateTransport("Supervisor connection closed");
    if (this.#initiatedClose || !retryable || this.#revokeRuntimeOnRetryableDisconnect) {
      this.#revokeRuntime("Supervisor connection closed");
    }
    this.#state = "closed";
    this.#settleClosed({
      initiatedByClient: this.#initiatedClose,
      code,
      reason: reason.slice(0, 123),
      retryable,
      ...(this.#failureCode === undefined ? {} : { failureCode: this.#failureCode }),
    });
  }

  #revokeRuntime(message: string): void {
    if (this.#runtimeRevoked) return;
    this.#runtimeRevoked = true;
    this.#invalidateTransport(message);
    this.#runtime.revokeAllAssignments();
  }

  #invalidateTransport(message: string): void {
    if (this.#transportInvalidated) return;
    this.#transportInvalidated = true;
    const error = new SupervisorWebSocketClientError(
      "event_transport_closed",
      message.slice(0, 4_096) || "Supervisor event transport closed",
      true,
    );
    for (const pending of this.#pendingEventAcknowledgements.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingEventAcknowledgements.clear();
    for (const entry of this.#preparedCommands.values()) {
      if (!entry.committed) entry.prepared.releaseBeforeStart();
    }
    this.#preparedCommands.clear();
  }

  #clearTimers(): void {
    if (this.#connectTimer !== undefined) clearTimeout(this.#connectTimer);
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    if (this.#pendingHeartbeat !== undefined) clearTimeout(this.#pendingHeartbeat.timeout);
    this.#connectTimer = undefined;
    this.#heartbeatTimer = undefined;
    this.#pendingHeartbeat = undefined;
    this.#heartbeatRefreshRequested = false;
  }

  #settleClosed(value: SupervisorWebSocketClientClose): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#resolveClosed(value);
  }
}
