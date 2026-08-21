import type { SupervisorRegisteredMessage } from "@pi-cloud/protocol";
import {
  SupervisorWebSocketClient,
  SupervisorWebSocketClientError,
  type SupervisorControlRuntime,
  type SupervisorWebSocketClientClose,
  type SupervisorWebSocketClientOptions,
} from "./supervisor-websocket-client.ts";

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 250;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_STABLE_CONNECTION_MS = 30_000;
const DEFAULT_ASSIGNMENT_TEARDOWN_TIMEOUT_MS = 30_000;

export interface ReconnectingSupervisorControlRuntime extends SupervisorControlRuntime {
  readonly activeSessionCount: number;
  waitUntilAssignmentsSettled(): Promise<void>;
}

export interface SupervisorWebSocketConnection {
  readonly connectionId: string | undefined;
  setAcceptingAssignments(value: boolean): void;
  start(): Promise<SupervisorRegisteredMessage>;
  stop(): Promise<SupervisorWebSocketClientClose>;
  waitUntilClosed(): Promise<SupervisorWebSocketClientClose>;
}

export type SupervisorWebSocketConnectionFactory = (
  options: SupervisorWebSocketClientOptions,
) => SupervisorWebSocketConnection;

export type ReconnectingSupervisorWebSocketClientOptions = Omit<
  SupervisorWebSocketClientOptions,
  "runtime"
> & {
  runtime: ReconnectingSupervisorControlRuntime;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  stableConnectionMs?: number;
  assignmentTeardownTimeoutMs?: number;
  random?: () => number;
  connectionFactory?: SupervisorWebSocketConnectionFactory;
};

export type ReconnectingSupervisorWebSocketClientState =
  "idle" | "connecting" | "connected" | "backing_off" | "stopping" | "stopped" | "failed";

export type ReconnectingSupervisorWebSocketClientStop = {
  reason: "requested" | "terminal_failure";
  connectionAttempts: number;
  successfulConnections: number;
  failureCode?: string;
  lastClose?: SupervisorWebSocketClientClose;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedMultiplier(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    throw new TypeError("reconnectBackoffMultiplier must be between 1 and 10");
  }
  return value;
}

function clientOptions(
  options: ReconnectingSupervisorWebSocketClientOptions,
): SupervisorWebSocketClientOptions {
  const runtime: SupervisorControlRuntime = {
    createHeartbeat(identity, acceptingAssignments) {
      const heartbeat = options.runtime.createHeartbeat(identity, acceptingAssignments);
      return {
        ...heartbeat,
        payload: { ...heartbeat.payload, sessions: [] },
      };
    },
    applyHeartbeatAcknowledgement(heartbeat, acknowledgement) {
      return options.runtime.applyHeartbeatAcknowledgement(heartbeat, acknowledgement);
    },
    prepareSteer(value) {
      return options.runtime.prepareSteer(value);
    },
    revokeAllAssignments() {
      return options.runtime.revokeAllAssignments();
    },
  };
  const result: SupervisorWebSocketClientOptions = {
    url: options.url,
    authorizationHeader: options.authorizationHeader,
    registration: options.registration,
    runtime,
    // A retryable WebSocket break suspends only the management transport. The
    // active Worker execution independently renews its fenced PostgreSQL
    // lease and may continue while this wrapper reconnects.
    revokeRuntimeOnRetryableDisconnect: false,
  };
  if (options.clock !== undefined) result.clock = options.clock;
  if (options.idGenerator !== undefined) result.idGenerator = options.idGenerator;
  if (options.connectTimeoutMs !== undefined) result.connectTimeoutMs = options.connectTimeoutMs;
  if (options.closeTimeoutMs !== undefined) result.closeTimeoutMs = options.closeTimeoutMs;
  if (options.maxPayloadBytes !== undefined) result.maxPayloadBytes = options.maxPayloadBytes;
  if (options.maxPendingFrames !== undefined) result.maxPendingFrames = options.maxPendingFrames;
  if (options.maxBufferedSendBytes !== undefined) {
    result.maxBufferedSendBytes = options.maxBufferedSendBytes;
  }
  return result;
}

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof SupervisorWebSocketClientError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "supervisor_connection_failed",
    message: "Supervisor connection attempt failed",
    retryable: false,
  };
}

export class ReconnectingSupervisorWebSocketClient {
  readonly #clientOptions: SupervisorWebSocketClientOptions;
  readonly #runtime: ReconnectingSupervisorControlRuntime;
  readonly #initialReconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #reconnectBackoffMultiplier: number;
  readonly #stableConnectionMs: number;
  readonly #assignmentTeardownTimeoutMs: number;
  readonly #random: () => number;
  readonly #connectionFactory: SupervisorWebSocketConnectionFactory;
  readonly #stoppedPromise: Promise<ReconnectingSupervisorWebSocketClientStop>;
  readonly #resolveStopped: (value: ReconnectingSupervisorWebSocketClientStop) => void;
  #state: ReconnectingSupervisorWebSocketClientState = "idle";
  #current: SupervisorWebSocketConnection | undefined;
  #loopPromise: Promise<void> | undefined;
  #startResolve: ((value: SupervisorRegisteredMessage) => void) | undefined;
  #startReject: ((error: SupervisorWebSocketClientError) => void) | undefined;
  #cancelBackoff: (() => void) | undefined;
  #stopRequested = false;
  #startSettled = false;
  #stoppedSettled = false;
  #acceptingAssignments = true;
  #connectionAttempts = 0;
  #successfulConnections = 0;
  #lastClose: SupervisorWebSocketClientClose | undefined;

  constructor(options: ReconnectingSupervisorWebSocketClientOptions) {
    this.#clientOptions = clientOptions(options);
    this.#runtime = options.runtime;
    this.#initialReconnectDelayMs = positiveInteger(
      options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS,
      "initialReconnectDelayMs",
    );
    this.#maxReconnectDelayMs = positiveInteger(
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      "maxReconnectDelayMs",
    );
    if (this.#maxReconnectDelayMs < this.#initialReconnectDelayMs) {
      throw new TypeError("maxReconnectDelayMs must be at least initialReconnectDelayMs");
    }
    this.#reconnectBackoffMultiplier = boundedMultiplier(
      options.reconnectBackoffMultiplier ?? DEFAULT_RECONNECT_BACKOFF_MULTIPLIER,
    );
    this.#stableConnectionMs = positiveInteger(
      options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS,
      "stableConnectionMs",
    );
    this.#assignmentTeardownTimeoutMs = positiveInteger(
      options.assignmentTeardownTimeoutMs ?? DEFAULT_ASSIGNMENT_TEARDOWN_TIMEOUT_MS,
      "assignmentTeardownTimeoutMs",
    );
    this.#random = options.random ?? Math.random;
    this.#connectionFactory =
      options.connectionFactory ??
      ((connectionOptions) => new SupervisorWebSocketClient(connectionOptions));
    let resolveStopped!: (value: ReconnectingSupervisorWebSocketClientStop) => void;
    this.#stoppedPromise = new Promise((resolvePromise) => {
      resolveStopped = resolvePromise;
    });
    this.#resolveStopped = resolveStopped;
  }

  get state(): ReconnectingSupervisorWebSocketClientState {
    return this.#state;
  }

  get connectionId(): string | undefined {
    return this.#current?.connectionId;
  }

  get connectionAttempts(): number {
    return this.#connectionAttempts;
  }

  get successfulConnections(): number {
    return this.#successfulConnections;
  }

  setAcceptingAssignments(value: boolean): void {
    this.#acceptingAssignments = value;
    this.#current?.setAcceptingAssignments(value);
  }

  start(): Promise<SupervisorRegisteredMessage> {
    if (this.#state !== "idle") {
      return Promise.reject(
        new SupervisorWebSocketClientError(
          "invalid_client_state",
          "Reconnecting supervisor client was already started",
          false,
        ),
      );
    }
    this.#state = "connecting";
    const started = new Promise<SupervisorRegisteredMessage>((resolvePromise, rejectPromise) => {
      this.#startResolve = resolvePromise;
      this.#startReject = rejectPromise;
    });
    this.#loopPromise = this.#runLoop().catch((error: unknown) => {
      const failure = safeFailure(error);
      this.#terminalFailure(failure.code, failure.message);
    });
    return started;
  }

  waitUntilStopped(): Promise<ReconnectingSupervisorWebSocketClientStop> {
    return this.#stoppedPromise;
  }

  async stop(): Promise<ReconnectingSupervisorWebSocketClientStop> {
    if (this.#state === "idle") {
      this.#stopRequested = true;
      this.#state = "stopped";
      this.#settleStartFailure(
        new SupervisorWebSocketClientError(
          "supervisor_client_stopped",
          "Reconnecting supervisor client was stopped",
          false,
        ),
      );
      this.#settleStopped({
        reason: "requested",
        connectionAttempts: 0,
        successfulConnections: 0,
      });
      return this.#stoppedPromise;
    }
    if (this.#state === "stopped" || this.#state === "failed") {
      return this.#stoppedPromise;
    }
    this.#stopRequested = true;
    this.#state = "stopping";
    this.#runtime.revokeAllAssignments();
    this.#cancelBackoff?.();
    await this.#current?.stop().catch(() => undefined);
    await this.#loopPromise;
    return this.#stoppedPromise;
  }

  async #runLoop(): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.#stopRequested) {
      this.#state = "connecting";
      const connection = this.#connectionFactory(this.#clientOptions);
      connection.setAcceptingAssignments(false);
      this.#current = connection;
      this.#connectionAttempts += 1;
      let connectedAt: number | undefined;
      let registration: SupervisorRegisteredMessage | undefined;
      let startFailure: { code: string; message: string; retryable: boolean } | undefined;
      try {
        registration = await connection.start();
        connection.setAcceptingAssignments(this.#acceptingAssignments);
        connectedAt = Date.now();
        this.#successfulConnections += 1;
        this.#state = "connected";
        this.#settleStartSuccess(registration);
      } catch (error: unknown) {
        startFailure = safeFailure(error);
      }

      const close = await connection.waitUntilClosed();
      this.#lastClose = close;
      if (this.#current === connection) this.#current = undefined;

      if (this.#stopRequested) {
        try {
          await this.#waitForAssignmentTeardown();
        } catch (error: unknown) {
          const failure = safeFailure(error);
          this.#terminalFailure(failure.code, failure.message);
          return;
        }
        this.#requestedStop();
        return;
      }

      const retryable = (startFailure?.retryable ?? true) && close.retryable;
      if (!retryable) {
        this.#runtime.revokeAllAssignments();
        try {
          await this.#waitForAssignmentTeardown();
        } catch (error: unknown) {
          const failure = safeFailure(error);
          this.#terminalFailure(failure.code, failure.message);
          return;
        }
        this.#terminalFailure(
          startFailure?.code ?? close.failureCode ?? "supervisor_connection_closed",
          startFailure?.message ?? "Supervisor connection closed permanently",
        );
        return;
      }

      if (
        registration !== undefined &&
        connectedAt !== undefined &&
        Date.now() - connectedAt >= this.#stableConnectionMs
      ) {
        consecutiveFailures = 0;
      }
      const delayMs = this.#backoffDelay(consecutiveFailures);
      consecutiveFailures += 1;
      this.#state = "backing_off";
      await this.#waitForBackoff(delayMs);
    }
    this.#requestedStop();
  }

  async #waitForAssignmentTeardown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#runtime.waitUntilAssignmentsSettled(),
        new Promise<never>((_resolvePromise, rejectPromise) => {
          timer = setTimeout(() => {
            rejectPromise(
              new SupervisorWebSocketClientError(
                "assignment_teardown_timeout",
                "Revoked supervisor assignments did not settle before reconnect",
                false,
              ),
            );
          }, this.#assignmentTeardownTimeoutMs);
          timer.unref();
        }),
      ]);
    } catch (error: unknown) {
      if (error instanceof SupervisorWebSocketClientError) throw error;
      throw new SupervisorWebSocketClientError(
        "assignment_teardown_failed",
        "Revoked supervisor assignments could not be settled",
        false,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #backoffDelay(consecutiveFailures: number): number {
    const exponent = Math.min(consecutiveFailures, 52);
    const base = Math.min(
      this.#maxReconnectDelayMs,
      this.#initialReconnectDelayMs * this.#reconnectBackoffMultiplier ** exponent,
    );
    const random = this.#random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new SupervisorWebSocketClientError(
        "invalid_reconnect_random",
        "Reconnect random source returned an invalid value",
        false,
      );
    }
    return Math.max(1, Math.floor(base / 2 + (random * base) / 2));
  }

  #waitForBackoff(delayMs: number): Promise<void> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#cancelBackoff === settle) this.#cancelBackoff = undefined;
        resolvePromise();
      };
      const timer = setTimeout(settle, delayMs);
      timer.unref();
      this.#cancelBackoff = settle;
      if (this.#stopRequested) settle();
    });
  }

  #settleStartSuccess(registration: SupervisorRegisteredMessage): void {
    if (this.#startSettled) return;
    this.#startSettled = true;
    this.#startResolve?.(registration);
    this.#startResolve = undefined;
    this.#startReject = undefined;
  }

  #settleStartFailure(error: SupervisorWebSocketClientError): void {
    if (this.#startSettled) return;
    this.#startSettled = true;
    this.#startReject?.(error);
    this.#startResolve = undefined;
    this.#startReject = undefined;
  }

  #terminalFailure(code: string, message: string): void {
    this.#state = "failed";
    this.#settleStartFailure(new SupervisorWebSocketClientError(code, message, false));
    this.#settleStopped({
      reason: "terminal_failure",
      connectionAttempts: this.#connectionAttempts,
      successfulConnections: this.#successfulConnections,
      failureCode: code,
      ...(this.#lastClose === undefined ? {} : { lastClose: this.#lastClose }),
    });
  }

  #requestedStop(): void {
    this.#state = "stopped";
    this.#settleStartFailure(
      new SupervisorWebSocketClientError(
        "supervisor_client_stopped",
        "Reconnecting supervisor client was stopped",
        false,
      ),
    );
    this.#settleStopped({
      reason: "requested",
      connectionAttempts: this.#connectionAttempts,
      successfulConnections: this.#successfulConnections,
      ...(this.#lastClose === undefined ? {} : { lastClose: this.#lastClose }),
    });
  }

  #settleStopped(value: ReconnectingSupervisorWebSocketClientStop): void {
    if (this.#stoppedSettled) return;
    this.#stoppedSettled = true;
    this.#resolveStopped(value);
  }
}
