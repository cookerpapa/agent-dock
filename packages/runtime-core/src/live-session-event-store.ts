import {
  parseAgentDockEvent,
  type AgentDockEvent,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { Cluster, Valkey } from "iovalkey";
import { createHash } from "node:crypto";

const APPEND_SCRIPT = String.raw`
local stream = KEYS[1]
local metadata = KEYS[2]
local tenant = ARGV[1]
local base = tonumber(ARGV[2])
local count = tonumber(ARGV[3])
local storedTenant = redis.call('HGET', metadata, 'tenant')
if storedTenant and storedTenant ~= tenant then
  return redis.error_reply('live_event_tenant_conflict')
end
local last = tonumber(redis.call('HGET', metadata, 'last_seq') or '0')
if last < base then
  last = base
elseif last > base then
  local finalSequence = tonumber(ARGV[4 + (count - 1) * 3])
  if finalSequence > last then
    return redis.error_reply('live_event_base_conflict')
  end
end
for index = 0, count - 1 do
  local offset = 4 + index * 3
  local sequence = tonumber(ARGV[offset])
  local digest = ARGV[offset + 1]
  local event = ARGV[offset + 2]
  local id = tostring(sequence) .. '-0'
  if sequence <= last then
    local existing = redis.call('XRANGE', stream, id, id, 'COUNT', 1)
    if #existing == 0 then
      return redis.error_reply('live_event_redelivery_missing')
    end
    local fields = existing[1][2]
    local existingDigest = nil
    for fieldIndex = 1, #fields, 2 do
      if fields[fieldIndex] == 'sha256' then
        existingDigest = fields[fieldIndex + 1]
      end
    end
    if existingDigest ~= digest then
      return redis.error_reply('live_event_redelivery_conflict')
    end
  else
    if sequence ~= last + 1 then
      return redis.error_reply('live_event_sequence_gap')
    end
    redis.call('XADD', stream, id, 'sha256', digest, 'event', event)
    last = sequence
  end
end
redis.call('HSET', metadata, 'tenant', tenant, 'last_seq', tostring(last))
return last
`;

const TRIM_SCRIPT = String.raw`
local stream = KEYS[1]
local metadata = KEYS[2]
local tenant = ARGV[1]
local through = tonumber(ARGV[2])
local storedTenant = redis.call('HGET', metadata, 'tenant')
if storedTenant and storedTenant ~= tenant then
  return redis.error_reply('live_event_tenant_conflict')
end
local floor = tonumber(redis.call('HGET', metadata, 'floor_seq') or '0')
if through > floor then
  redis.call('XTRIM', stream, 'MINID', '=', tostring(through + 1) .. '-0')
  redis.call('HSET', metadata, 'tenant', tenant, 'floor_seq', tostring(through))
end
return through
`;

const DEFAULT_PAGE_SIZE = 500;

export type AppendLiveSessionEventsInput = Readonly<{
  tenantId: string;
  sessionId: string;
  previousSequence: number;
  messages: readonly EventPublishMessage[];
}>;

export interface LiveSessionEventStore {
  append(input: AppendLiveSessionEventsInput): Promise<number>;
  readPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit?: number,
  ): Promise<readonly AgentDockEvent[]>;
  readTurn(
    tenantId: string,
    sessionId: string,
    turnId: string,
    afterSequence: number,
    throughSequence: number,
  ): Promise<readonly AgentDockEvent[]>;
  trimThrough(tenantId: string, sessionId: string, throughSequence: number): Promise<void>;
  checkHealth?(): Promise<void>;
  close?(): Promise<void>;
}

export class LiveSessionEventStoreError extends Error {
  readonly code:
    | "tenant_conflict"
    | "base_conflict"
    | "redelivery_missing"
    | "redelivery_conflict"
    | "sequence_gap"
    | "corrupt_event";

  constructor(code: LiveSessionEventStoreError["code"], message: string) {
    super(message);
    this.name = "LiveSessionEventStoreError";
    this.code = code;
  }
}

function nonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedIdentity(value: string, name: string): string {
  if (value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f{}]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function keys(sessionId: string): readonly [string, string] {
  const identity = boundedIdentity(sessionId, "sessionId");
  return [
    `agent-dock:live-events:{${identity}}:stream`,
    `agent-dock:live-events:{${identity}}:metadata`,
  ];
}

function publicationDigest(message: EventPublishMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

function parseFields(fields: readonly string[]): AgentDockEvent {
  let raw: string | undefined;
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === "event") raw = fields[index + 1];
  }
  if (raw === undefined) {
    throw new LiveSessionEventStoreError("corrupt_event", "Live event payload is missing");
  }
  try {
    return parseAgentDockEvent(JSON.parse(raw));
  } catch {
    throw new LiveSessionEventStoreError("corrupt_event", "Live event payload is invalid");
  }
}

function mappedScriptError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  const mappings = [
    ["live_event_tenant_conflict", "tenant_conflict"],
    ["live_event_base_conflict", "base_conflict"],
    ["live_event_redelivery_missing", "redelivery_missing"],
    ["live_event_redelivery_conflict", "redelivery_conflict"],
    ["live_event_sequence_gap", "sequence_gap"],
  ] as const;
  for (const [fragment, code] of mappings) {
    if (message.includes(fragment)) {
      throw new LiveSessionEventStoreError(
        code,
        "Live event stream rejected an inconsistent write",
      );
    }
  }
  throw error;
}

export class ValkeyLiveSessionEventStore implements LiveSessionEventStore {
  readonly #client: Valkey | Cluster;
  #connected: Promise<void> | undefined;
  #closed = false;

  constructor(options: { url: string }) {
    const endpoints = options.url.split(",").map((value) => new URL(value.trim()));
    if (
      endpoints.length < 1 ||
      endpoints.length > 64 ||
      endpoints.some(
        (endpoint) =>
          (endpoint.protocol !== "redis:" && endpoint.protocol !== "rediss:") ||
          endpoint.hash.length > 0 ||
          endpoint.search.length > 0 ||
          (endpoint.pathname !== "" && endpoint.pathname !== "/" && endpoint.pathname !== "/0"),
      )
    ) {
      throw new TypeError("Valkey live-event URL is invalid");
    }
    if (endpoints.length === 1) {
      this.#client = new Valkey(endpoints[0]!.href, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
        connectTimeout: 5_000,
        commandTimeout: 10_000,
      });
    } else {
      const first = endpoints[0]!;
      if (first.pathname === "/0" && endpoints.some((endpoint) => endpoint.pathname !== "/0")) {
        throw new TypeError("Valkey Cluster endpoints must use the same database");
      }
      if (
        endpoints.some(
          (endpoint) =>
            endpoint.protocol !== first.protocol ||
            endpoint.username !== first.username ||
            endpoint.password !== first.password,
        )
      ) {
        throw new TypeError("Valkey Cluster endpoints must share one credential and protocol");
      }
      this.#client = new Cluster(
        endpoints.map((endpoint) => ({
          host: endpoint.hostname,
          port: Number(endpoint.port || "6379"),
        })),
        {
          lazyConnect: true,
          enableOfflineQueue: false,
          redisOptions: {
            ...(first.username.length === 0 ? {} : { username: first.username }),
            ...(first.password.length === 0 ? {} : { password: first.password }),
            ...(first.protocol === "rediss:" ? { tls: {} } : {}),
            maxRetriesPerRequest: 2,
            connectTimeout: 5_000,
            commandTimeout: 10_000,
          },
        },
      );
    }
    this.#client.on("error", () => undefined);
  }

  async append(input: AppendLiveSessionEventsInput): Promise<number> {
    if (input.messages.length < 1 || input.messages.length > 1_024) {
      throw new TypeError("Live event append must contain 1-1024 events");
    }
    nonNegative(input.previousSequence, "previousSequence");
    boundedIdentity(input.tenantId, "tenantId");
    const [streamKey, metadataKey] = keys(input.sessionId);
    const arguments_: Array<string | number> = [
      input.tenantId,
      input.previousSequence,
      input.messages.length,
    ];
    let expected = input.messages[0]!.payload.event.seq;
    for (const message of input.messages) {
      const event = message.payload.event;
      if (event.sessionId !== input.sessionId || event.seq !== expected) {
        throw new TypeError("Live event append is not one contiguous Session range");
      }
      arguments_.push(event.seq, publicationDigest(message), JSON.stringify(event));
      expected += 1;
    }
    await this.#connect();
    try {
      const result = await this.#client.eval(
        APPEND_SCRIPT,
        2,
        streamKey,
        metadataKey,
        ...arguments_,
      );
      return positive(Number(result), "live event append result");
    } catch (error: unknown) {
      return mappedScriptError(error);
    }
  }

  async readPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<readonly AgentDockEvent[]> {
    nonNegative(afterSequence, "afterSequence");
    nonNegative(throughSequence, "throughSequence");
    positive(limit, "limit");
    if (throughSequence < afterSequence) throw new TypeError("Live event range is invalid");
    const [streamKey, metadataKey] = keys(sessionId);
    await this.#connect();
    const storedTenant = await this.#client.hget(metadataKey, "tenant");
    if (storedTenant !== null && storedTenant !== tenantId) {
      throw new LiveSessionEventStoreError("tenant_conflict", "Live event tenant is invalid");
    }
    if (afterSequence === throughSequence) return [];
    const rows = await this.#client.xrange(
      streamKey,
      `${String(afterSequence + 1)}-0`,
      `${String(throughSequence)}-0`,
      "COUNT",
      limit,
    );
    return rows.map((row: [string, string[]]) => parseFields(row[1]));
  }

  async readTurn(
    tenantId: string,
    sessionId: string,
    turnId: string,
    afterSequence: number,
    throughSequence: number,
  ): Promise<readonly AgentDockEvent[]> {
    const events: AgentDockEvent[] = [];
    let cursor = afterSequence;
    while (cursor < throughSequence) {
      const page = await this.readPage(
        tenantId,
        sessionId,
        cursor,
        throughSequence,
        DEFAULT_PAGE_SIZE,
      );
      if (page.length === 0) break;
      for (const event of page) {
        if (event.turnId === turnId) events.push(event);
      }
      cursor = page.at(-1)!.seq;
    }
    return events;
  }

  async trimThrough(tenantId: string, sessionId: string, throughSequence: number): Promise<void> {
    nonNegative(throughSequence, "throughSequence");
    const [streamKey, metadataKey] = keys(sessionId);
    await this.#connect();
    try {
      await this.#client.eval(TRIM_SCRIPT, 2, streamKey, metadataKey, tenantId, throughSequence);
    } catch (error: unknown) {
      mappedScriptError(error);
    }
  }

  async checkHealth(): Promise<void> {
    await this.#connect();
    const response = await this.#client.ping();
    if (response !== "PONG") throw new Error("Valkey live-event store is unavailable");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#connected !== undefined) {
      await this.#connected.catch(() => undefined);
      this.#client.disconnect();
    }
  }

  #connect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Valkey live-event store is closed"));
    if (this.#connected === undefined) this.#connected = this.#client.connect();
    return this.#connected;
  }
}

/** Deterministic single-process adapter for tests and local profiles. */
export class MemoryLiveSessionEventStore implements LiveSessionEventStore {
  readonly #streams = new Map<
    string,
    { tenantId: string; events: Map<number, EventPublishMessage> }
  >();

  async append(input: AppendLiveSessionEventsInput): Promise<number> {
    const stream = this.#streams.get(input.sessionId) ?? {
      tenantId: input.tenantId,
      events: new Map<number, EventPublishMessage>(),
    };
    if (stream.tenantId !== input.tenantId) {
      throw new LiveSessionEventStoreError("tenant_conflict", "Live event tenant is invalid");
    }
    let last = Math.max(input.previousSequence, ...stream.events.keys(), 0);
    for (const message of input.messages) {
      const sequence = message.payload.event.seq;
      const existing = stream.events.get(sequence);
      if (existing !== undefined) {
        if (publicationDigest(existing) !== publicationDigest(message)) {
          throw new LiveSessionEventStoreError(
            "redelivery_conflict",
            "Live event redelivery conflicted",
          );
        }
        continue;
      }
      if (sequence !== last + 1) {
        throw new LiveSessionEventStoreError("sequence_gap", "Live event sequence has a gap");
      }
      stream.events.set(sequence, message);
      last = sequence;
    }
    this.#streams.set(input.sessionId, stream);
    return last;
  }

  async readPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<readonly AgentDockEvent[]> {
    const stream = this.#streams.get(sessionId);
    if (stream === undefined) return [];
    if (stream.tenantId !== tenantId) {
      throw new LiveSessionEventStoreError("tenant_conflict", "Live event tenant is invalid");
    }
    return [...stream.events]
      .filter(([sequence]) => sequence > afterSequence && sequence <= throughSequence)
      .sort(([left], [right]) => left - right)
      .slice(0, limit)
      .map(([, message]) => message.payload.event);
  }

  async readTurn(
    tenantId: string,
    sessionId: string,
    turnId: string,
    afterSequence: number,
    throughSequence: number,
  ): Promise<readonly AgentDockEvent[]> {
    const events = await this.readPage(
      tenantId,
      sessionId,
      afterSequence,
      throughSequence,
      Number.MAX_SAFE_INTEGER,
    );
    return events.filter((event) => event.turnId === turnId);
  }

  async trimThrough(tenantId: string, sessionId: string, throughSequence: number): Promise<void> {
    const stream = this.#streams.get(sessionId);
    if (stream === undefined) return;
    if (stream.tenantId !== tenantId) {
      throw new LiveSessionEventStoreError("tenant_conflict", "Live event tenant is invalid");
    }
    for (const sequence of stream.events.keys()) {
      if (sequence <= throughSequence) stream.events.delete(sequence);
    }
  }
}
