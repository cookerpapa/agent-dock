import type { Database } from "@agent-dock/database";
import { parseSupervisorToControlMessage, type EventPublishMessage } from "@agent-dock/protocol";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { sql, type Kysely } from "kysely";
import { createHash, randomUUID } from "node:crypto";

const { CompressionTypes, Kafka, logLevel } = KafkaJS;
type Producer = ReturnType<InstanceType<typeof Kafka>["producer"]>;
type Consumer = ReturnType<InstanceType<typeof Kafka>["consumer"]>;

export type WorkerEventLogBatch = Readonly<{
  tenantId: string;
  messages: readonly EventPublishMessage[];
}>;

export type WorkerEventLogEnvelope = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  messages: readonly EventPublishMessage[];
}>;

export interface WorkerEventLogAppender {
  append(batches: readonly WorkerEventLogBatch[]): Promise<void>;
  checkHealth?(): Promise<void>;
  close?(): Promise<void>;
}

export interface WorkerEventProjectionSink {
  project(envelope: WorkerEventLogEnvelope): Promise<void>;
}

export type KafkaWorkerEventLogOptions = Readonly<{
  brokers: readonly string[];
  clientId: string;
  topic: string;
  security?: Readonly<{
    ca: string;
    username: string;
    password: string;
  }>;
}>;

export type KafkaWorkerEventProjectorOptions = KafkaWorkerEventLogOptions &
  Readonly<{
    groupId: string;
    sink: WorkerEventProjectionSink;
    partitionsConsumedConcurrently?: number;
  }>;

function bounded(value: string, name: string, maximum = 249): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function secretMaterial(value: string, name: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function brokers(values: readonly string[]): string {
  if (values.length < 1 || values.length > 64) throw new TypeError("brokers is invalid");
  const normalized = values.map((value) => bounded(value, "broker", 512));
  if (new Set(normalized).size !== normalized.length) throw new TypeError("brokers must be unique");
  return normalized.join(",");
}

export function parseWorkerEventLogEnvelope(value: Buffer | string | null): WorkerEventLogEnvelope {
  if (value === null) throw new TypeError("Kafka Worker event envelope was empty");
  const parsed = JSON.parse(value.toString()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Kafka Worker event envelope was invalid");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.tenantId !== "string" ||
    candidate.tenantId.length < 1 ||
    candidate.tenantId.length > 64 ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length < 1 ||
    candidate.messages.length > 1_024
  ) {
    throw new TypeError("Kafka Worker event envelope was invalid");
  }
  const messages = candidate.messages.map((message) => {
    const publication = parseSupervisorToControlMessage(message);
    if (publication.type !== "event.publish") {
      throw new TypeError("Kafka Worker event envelope contained a non-event message");
    }
    return publication;
  });
  const sessionId = messages[0]!.payload.event.sessionId;
  if (messages.some((message) => message.payload.event.sessionId !== sessionId)) {
    throw new TypeError("Kafka Worker event envelope mixed Sessions");
  }
  return Object.freeze({
    schemaVersion: 1,
    tenantId: candidate.tenantId,
    messages: Object.freeze(messages),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function envelopeHash(envelope: WorkerEventLogEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex");
}

function kafka(options: KafkaWorkerEventLogOptions): InstanceType<typeof Kafka> {
  const bootstrapServers = brokers(options.brokers);
  return new Kafka({
    "bootstrap.servers": bootstrapServers,
    "client.id": bounded(options.clientId, "clientId"),
    ...(options.security === undefined
      ? {}
      : {
          "security.protocol": "sasl_ssl",
          "sasl.mechanisms": "SCRAM-SHA-512",
          "sasl.username": bounded(options.security.username, "Kafka username", 256),
          "sasl.password": bounded(options.security.password, "Kafka password", 512),
          "ssl.ca.pem": secretMaterial(options.security.ca, "Kafka CA", 1_048_576),
        }),
  });
}

export class KafkaWorkerEventLog implements WorkerEventLogAppender {
  readonly #topic: string;
  readonly #producer: Producer;
  #connected: Promise<void> | undefined;
  #closed = false;

  constructor(options: KafkaWorkerEventLogOptions) {
    this.#topic = bounded(options.topic, "topic");
    this.#producer = kafka(options).producer({
      "allow.auto.create.topics": false,
      "enable.idempotence": true,
      "max.in.flight.requests.per.connection": 5,
      acks: -1,
      "compression.codec": CompressionTypes.GZIP,
    });
    this.#producer.logger().setLogLevel(logLevel.NOTHING);
  }

  async append(batches: readonly WorkerEventLogBatch[]): Promise<void> {
    if (this.#closed) throw new Error("Kafka Worker event log is closed");
    if (batches.length < 1 || batches.length > 2_048) {
      throw new TypeError("Kafka Worker event append group is invalid");
    }
    await this.#connect();
    await this.#producer.send({
      topic: this.#topic,
      messages: batches.map((batch) => {
        const first = batch.messages[0];
        if (first === undefined) throw new TypeError("Kafka Worker event batch was empty");
        const sessionId = first.payload.event.sessionId;
        if (batch.messages.some((message) => message.payload.event.sessionId !== sessionId)) {
          throw new TypeError("Kafka Worker event batch mixed Sessions");
        }
        const envelope: WorkerEventLogEnvelope = {
          schemaVersion: 1,
          tenantId: batch.tenantId,
          messages: batch.messages,
        };
        return {
          key: sessionId,
          value: JSON.stringify(envelope),
          headers: {
            "agent-dock-schema": "worker-events-v1",
            "agent-dock-tenant": batch.tenantId,
          },
        };
      }),
    });
  }

  async checkHealth(): Promise<void> {
    await this.#connect();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#connected !== undefined) {
      await this.#connected;
      await this.#producer.disconnect();
    }
  }

  #connect(): Promise<void> {
    this.#connected ??= this.#producer.connect();
    return this.#connected;
  }
}

export class KafkaWorkerEventProjector {
  readonly #topic: string;
  readonly #sink: WorkerEventProjectionSink;
  readonly #partitionsConsumedConcurrently: number;
  readonly #consumer: Consumer;
  #started = false;
  #closed = false;
  #runPromise: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: KafkaWorkerEventProjectorOptions) {
    this.#topic = bounded(options.topic, "topic");
    this.#sink = options.sink;
    this.#partitionsConsumedConcurrently = options.partitionsConsumedConcurrently ?? 4;
    if (
      !Number.isSafeInteger(this.#partitionsConsumedConcurrently) ||
      this.#partitionsConsumedConcurrently < 1 ||
      this.#partitionsConsumedConcurrently > 64
    ) {
      throw new TypeError("partitionsConsumedConcurrently is invalid");
    }
    this.#consumer = kafka(options).consumer({
      "group.id": bounded(options.groupId, "groupId"),
      "allow.auto.create.topics": false,
      "auto.offset.reset": "earliest",
    });
    this.#consumer.logger().setLogLevel(logLevel.NOTHING);
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) throw new Error("Kafka Worker event projector cannot start");
    await this.#consumer.connect();
    await this.#consumer.subscribe({ topics: [this.#topic] });
    this.#started = true;
    this.#runPromise = this.#consumer
      .run({
        partitionsConsumedConcurrently: this.#partitionsConsumedConcurrently,
        eachMessage: async ({ message }) => {
          await this.#sink.project(parseWorkerEventLogEnvelope(message.value));
        },
      })
      .catch((error: unknown) => {
        this.#failure = error;
      });
  }

  checkHealth(): void {
    if (!this.#started || this.#closed || this.#failure !== undefined) {
      throw new Error("Kafka Worker event projector is not healthy");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#started) return;
    await this.#consumer.disconnect();
    await this.#runPromise;
    this.#started = false;
  }
}

export type PostgresWorkerEventOutboxPublisherOptions = Readonly<{
  database: Kysely<Database>;
  eventLog: WorkerEventLogAppender;
  publisherId?: string;
  batchSize?: number;
  claimDurationMs?: number;
  idlePollMs?: number;
  publishedRetentionMs?: number;
  clock?: () => Date;
}>;

type ClaimedOutboxRow = Readonly<{
  id: string;
  tenant_id: string;
  envelope: Record<string, unknown>;
  content_sha256: string;
  attempts: number;
}>;

function positiveBounded(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export class PostgresWorkerEventOutboxPublisher {
  readonly #database: Kysely<Database>;
  readonly #eventLog: WorkerEventLogAppender;
  readonly #publisherId: string;
  readonly #batchSize: number;
  readonly #claimDurationMs: number;
  readonly #idlePollMs: number;
  readonly #clock: () => Date;
  readonly #publishedRetentionMs: number;
  #closed = false;
  #runPromise: Promise<void> | undefined;
  #nextPruneAt = 0;

  constructor(options: PostgresWorkerEventOutboxPublisherOptions) {
    this.#database = options.database;
    this.#eventLog = options.eventLog;
    this.#publisherId = bounded(
      options.publisherId ?? `event-bridge-${randomUUID()}`,
      "publisherId",
    );
    this.#batchSize = positiveBounded(options.batchSize ?? 128, "batchSize", 2_048);
    this.#claimDurationMs = positiveBounded(
      options.claimDurationMs ?? 30_000,
      "claimDurationMs",
      300_000,
    );
    this.#idlePollMs = positiveBounded(options.idlePollMs ?? 100, "idlePollMs", 10_000);
    this.#clock = options.clock ?? (() => new Date());
    this.#publishedRetentionMs = positiveBounded(
      options.publishedRetentionMs ?? 24 * 60 * 60_000,
      "publishedRetentionMs",
      30 * 24 * 60 * 60_000,
    );
  }

  async start(): Promise<void> {
    if (this.#closed || this.#runPromise !== undefined) {
      throw new Error("Worker event Outbox publisher cannot start");
    }
    await this.#eventLog.checkHealth?.();
    this.#runPromise = this.#run();
  }

  async drainOnce(): Promise<number> {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError("Worker event Outbox clock returned an invalid Date");
    }
    const claimedUntil = new Date(now.valueOf() + this.#claimDurationMs);
    const claimed = await this.#database.transaction().execute(async (transaction) => {
      const result = await sql<ClaimedOutboxRow>`
        with candidates as (
          select candidate.id
            from worker_event_outbox as candidate
           where candidate.state = 'pending'
             and candidate.available_at <= ${now}
             and (candidate.claimed_until is null or candidate.claimed_until <= ${now})
             and not exists (
               select 1
                 from worker_event_outbox as earlier
                where earlier.session_id = candidate.session_id
                  and earlier.state = 'pending'
                  and earlier.first_seq < candidate.first_seq
             )
           order by candidate.created_at asc, candidate.id asc
           for update skip locked
           limit ${this.#batchSize}
        )
        update worker_event_outbox as row
           set claimed_by = ${this.#publisherId},
               claimed_until = ${claimedUntil}
          from candidates
         where row.id = candidates.id
        returning row.id, row.tenant_id, row.envelope, row.content_sha256, row.attempts
      `.execute(transaction);
      return result.rows;
    });
    if (claimed.length === 0) return 0;

    try {
      const batches = claimed.map((row) => {
        const envelope = parseWorkerEventLogEnvelope(JSON.stringify(row.envelope));
        if (envelope.tenantId !== row.tenant_id || envelopeHash(envelope) !== row.content_sha256) {
          throw new Error("Worker event Outbox envelope failed its integrity check");
        }
        return { tenantId: envelope.tenantId, messages: envelope.messages };
      });
      await this.#eventLog.append(batches);
      const completedAt = this.#clock();
      await this.#database
        .updateTable("worker_event_outbox")
        .set({
          state: "published",
          published_at: completedAt,
          claimed_by: null,
          claimed_until: null,
          last_error: null,
        })
        .where(
          "id",
          "in",
          claimed.map((row) => row.id),
        )
        .where("claimed_by", "=", this.#publisherId)
        .execute();
      await this.#prunePublished(completedAt);
      return claimed.length;
    } catch (error) {
      const failedAt = this.#clock();
      const maximumAttempts = Math.max(...claimed.map((row) => row.attempts + 1));
      const retryAt = new Date(
        failedAt.valueOf() + Math.min(30_000, 100 * 2 ** Math.min(maximumAttempts, 8)),
      );
      await this.#database
        .updateTable("worker_event_outbox")
        .set({
          attempts: sql<number>`${sql.ref("attempts")} + 1`,
          available_at: retryAt,
          claimed_by: null,
          claimed_until: null,
          last_error:
            error instanceof Error ? error.message.slice(0, 1_000) : "Kafka append failed",
        })
        .where(
          "id",
          "in",
          claimed.map((row) => row.id),
        )
        .where("claimed_by", "=", this.#publisherId)
        .execute();
      throw error;
    }
  }

  async checkHealth(): Promise<void> {
    if (this.#closed) throw new Error("Worker event Outbox publisher is closed");
    await this.#eventLog.checkHealth?.();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#runPromise;
    await this.#eventLog.close?.();
  }

  async #run(): Promise<void> {
    while (!this.#closed) {
      try {
        const count = await this.drainOnce();
        if (count > 0) continue;
      } catch {
        // The durable row remains pending with bounded backoff. Keep the bridge alive.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.#idlePollMs));
    }
  }

  async #prunePublished(now: Date): Promise<void> {
    if (now.valueOf() < this.#nextPruneAt) return;
    this.#nextPruneAt = now.valueOf() + 60_000;
    const cutoff = new Date(now.valueOf() - this.#publishedRetentionMs);
    await sql`
      delete from worker_event_outbox
       where id in (
         select id
           from worker_event_outbox
          where state = 'published'
            and published_at < ${cutoff}
          order by published_at asc
          limit 1000
       )
    `.execute(this.#database);
  }
}
