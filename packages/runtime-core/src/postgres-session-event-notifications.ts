import type { Database } from "@agent-dock/database";
import { sql, type Transaction } from "kysely";
import { Client, type Notification } from "pg";
import type {
  SessionEventNotification,
  SessionEventNotificationHandlers,
  SessionEventNotificationTransport,
} from "./session-event-notifications.ts";

export const SESSION_EVENT_NOTIFICATION_CHANNEL = "agent_dock_session_events_v1";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 250;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_STABLE_CONNECTION_MS = 30_000;
const MAX_NOTIFICATION_PAYLOAD_BYTES = 7_900;

export type PostgresSessionEventNotificationsOptions = {
  connectionString: string;
  applicationName?: string;
  connectTimeoutMs?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  stableConnectionMs?: number;
  random?: () => number;
};

export type PostgresSessionEventNotificationsState =
  "idle" | "starting" | "listening" | "reconnecting" | "stopping" | "stopped" | "failed";

export class PostgresSessionEventNotificationsError extends Error {
  readonly code: "invalid_state" | "listener_connection_failed";

  constructor(code: PostgresSessionEventNotificationsError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "PostgresSessionEventNotificationsError";
    this.code = code;
  }
}

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

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function parseNotification(value: unknown): SessionEventNotification | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.tenantId !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.throughSequence !== "number" ||
    !Number.isSafeInteger(candidate.throughSequence) ||
    candidate.throughSequence < 1
  ) {
    return undefined;
  }
  try {
    return {
      schemaVersion: 1,
      tenantId: requireUuid(candidate.tenantId, "notification.tenantId"),
      sessionId: requireUuid(candidate.sessionId, "notification.sessionId"),
      throughSequence: candidate.throughSequence,
    };
  } catch {
    return undefined;
  }
}

export function parseSessionEventNotificationPayload(
  payload: string | undefined,
): SessionEventNotification | undefined {
  if (
    payload === undefined ||
    Buffer.byteLength(payload, "utf8") > MAX_NOTIFICATION_PAYLOAD_BYTES
  ) {
    return undefined;
  }
  try {
    return parseNotification(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

function validatedNotification(value: SessionEventNotification): SessionEventNotification {
  const parsed = parseNotification(value);
  if (parsed === undefined) throw new TypeError("session event notification is invalid");
  return parsed;
}

export class PostgresSessionEventNotifications implements SessionEventNotificationTransport {
  readonly #connectionString: string;
  readonly #applicationName: string;
  readonly #connectTimeoutMs: number;
  readonly #initialReconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #reconnectBackoffMultiplier: number;
  readonly #stableConnectionMs: number;
  readonly #random: () => number;
  #state: PostgresSessionEventNotificationsState = "idle";
  #handlers: SessionEventNotificationHandlers | undefined;
  #client: Client | undefined;
  #loop: Promise<void> | undefined;
  #cancelBackoff: (() => void) | undefined;
  #stopRequested = false;
  #successfulConnections = 0;

  constructor(options: PostgresSessionEventNotificationsOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new TypeError("connectionString must not be empty");
    }
    this.#connectionString = options.connectionString;
    const applicationName = options.applicationName ?? "agent-dock-session-event-listener";
    if (
      Buffer.byteLength(applicationName, "utf8") < 1 ||
      Buffer.byteLength(applicationName, "utf8") > 63 ||
      applicationName.includes("\0")
    ) {
      throw new TypeError("applicationName must contain between 1 and 63 safe bytes");
    }
    this.#applicationName = applicationName;
    this.#connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
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
    this.#random = options.random ?? Math.random;
  }

  get state(): PostgresSessionEventNotificationsState {
    return this.#state;
  }

  get successfulConnections(): number {
    return this.#successfulConnections;
  }

  async publish(
    transaction: Transaction<Database>,
    notification: SessionEventNotification,
  ): Promise<void> {
    const parsed = validatedNotification(notification);
    const payload = JSON.stringify(parsed);
    if (Buffer.byteLength(payload, "utf8") > MAX_NOTIFICATION_PAYLOAD_BYTES) {
      throw new TypeError("session event notification payload is too large");
    }
    await sql`select pg_notify(${SESSION_EVENT_NOTIFICATION_CHANNEL}, ${payload})`.execute(
      transaction,
    );
  }

  async publishGroup(
    transaction: Transaction<Database>,
    notifications: readonly SessionEventNotification[],
  ): Promise<void> {
    if (notifications.length < 1) return;
    const payloads = notifications.map((notification) => {
      const parsed = validatedNotification(notification);
      const payload = JSON.stringify(parsed);
      if (Buffer.byteLength(payload, "utf8") > MAX_NOTIFICATION_PAYLOAD_BYTES) {
        throw new TypeError("session event notification payload is too large");
      }
      return payload;
    });
    await sql`
      select pg_notify(${SESSION_EVENT_NOTIFICATION_CHANNEL}, payload)
        from jsonb_array_elements_text(${JSON.stringify(payloads)}::jsonb) as payload
    `.execute(transaction);
  }

  start(handlers: SessionEventNotificationHandlers): Promise<void> {
    if (this.#state !== "idle") {
      return Promise.reject(
        new PostgresSessionEventNotificationsError(
          "invalid_state",
          "PostgreSQL session event notifications were already started",
        ),
      );
    }
    this.#handlers = handlers;
    this.#state = "starting";
    let resolveStarted!: () => void;
    let rejectStarted!: (error: PostgresSessionEventNotificationsError) => void;
    const started = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveStarted = resolvePromise;
      rejectStarted = rejectPromise;
    });
    this.#loop = this.#runLoop(resolveStarted, rejectStarted).catch(() => {
      this.#state = "failed";
      rejectStarted(
        new PostgresSessionEventNotificationsError(
          "listener_connection_failed",
          "PostgreSQL session event listener failed",
        ),
      );
    });
    return started;
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopped") return;
    this.#stopRequested = true;
    if (this.#state !== "failed") this.#state = "stopping";
    this.#cancelBackoff?.();
    await this.#client?.end().catch(() => undefined);
    await this.#loop;
    this.#state = "stopped";
  }

  async #runLoop(
    resolveStarted: () => void,
    rejectStarted: (error: PostgresSessionEventNotificationsError) => void,
  ): Promise<void> {
    let connectedOnce = false;
    let consecutiveFailures = 0;
    while (!this.#stopRequested) {
      const client = new Client({
        connectionString: this.#connectionString,
        connectionTimeoutMillis: this.#connectTimeoutMs,
        application_name: this.#applicationName,
      });
      this.#client = client;
      let disconnect!: () => void;
      const disconnected = new Promise<void>((resolvePromise) => {
        disconnect = resolvePromise;
      });
      const onError = (): void => disconnect();
      const onEnd = (): void => disconnect();
      const onNotification = (message: Notification): void => this.#receive(message);
      client.on("error", onError);
      client.on("end", onEnd);
      client.on("notification", onNotification);
      let connectedAt: number | undefined;
      let connectionFailed = false;
      try {
        await client.connect();
        await client.query(`LISTEN ${SESSION_EVENT_NOTIFICATION_CHANNEL}`);
        if (this.#stopRequested) break;
        connectedAt = Date.now();
        this.#state = "listening";
        this.#successfulConnections += 1;
        if (!connectedOnce) {
          connectedOnce = true;
          resolveStarted();
        }
        try {
          this.#handlers?.onResync();
        } catch {
          // A local wake callback must not tear down a healthy database listener.
        }
        await disconnected;
      } catch {
        connectionFailed = true;
        if (!connectedOnce) {
          this.#state = "failed";
          this.#stopRequested = true;
          rejectStarted(
            new PostgresSessionEventNotificationsError(
              "listener_connection_failed",
              "PostgreSQL session event listener could not connect",
            ),
          );
        }
      } finally {
        client.off("error", onError);
        client.off("end", onEnd);
        client.off("notification", onNotification);
        if (this.#client === client) this.#client = undefined;
        await client.end().catch(() => undefined);
      }
      if (this.#stopRequested) break;
      if (
        !connectionFailed &&
        connectedAt !== undefined &&
        Date.now() - connectedAt >= this.#stableConnectionMs
      ) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
      this.#state = "reconnecting";
      await this.#waitForBackoff(this.#backoffDelay(consecutiveFailures - 1));
    }
  }

  #receive(message: Notification): void {
    if (message.channel !== SESSION_EVENT_NOTIFICATION_CHANNEL) return;
    const notification = parseSessionEventNotificationPayload(message.payload);
    if (notification === undefined) return;
    try {
      this.#handlers?.onNotification(notification);
    } catch {
      // A local wake callback must not tear down a healthy database listener.
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
      return this.#maxReconnectDelayMs;
    }
    return Math.max(1, Math.floor(base / 2 + (random * base) / 2));
  }

  #waitForBackoff(delayMs: number): Promise<void> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#cancelBackoff === settle) this.#cancelBackoff = undefined;
        resolvePromise();
      };
      const timer = setTimeout(settle, delayMs);
      timer.unref();
      this.#cancelBackoff = settle;
    });
  }
}
