import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  EachBatchPayload,
  EachMessagePayload,
} from "@confluentinc/kafka-javascript/types/kafkajs.d.ts";
import {
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishBatchMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import type { DurableEventGroupIngestor, DurableEventIngestor } from "./durable-event-store.ts";
import type { Database } from "@pi-cloud/database";
import { SESSION_TERMINAL_EVENT_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";

const { CompressionTypes, IsolationLevel, Kafka, logLevel } = KafkaJS;
type Producer = ReturnType<InstanceType<typeof Kafka>["producer"]>;
type Consumer = ReturnType<InstanceType<typeof Kafka>["consumer"]>;
type Admin = ReturnType<InstanceType<typeof Kafka>["admin"]>;

export type KafkaAgentEventEnvelope = Readonly<{
  schemaVersion: 1;
  publications: readonly (EventPublishMessage | EventPublishBatchMessage)[];
}>;

export type KafkaAcceptedAgentEventEnvelope = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  publications: readonly (EventPublishMessage | EventPublishBatchMessage)[];
}>;

export type KafkaAgentEventPosition = Readonly<{
  topic: string;
  partition: number;
  offset: string;
}>;

export type KafkaAgentEventLogOptions = Readonly<{
  brokers: readonly string[];
  clientId: string;
  topic: string;
  security?: Readonly<{ ca: string; username: string; password: string }>;
}>;

export type KafkaAgentEventProducerOptions = KafkaAgentEventLogOptions &
  Readonly<{ acceptedBarrier?: PostgresAcceptedEventBarrier }>;

export type KafkaAgentEventConsumerOptions = KafkaAgentEventLogOptions &
  Readonly<{
    groupId: string;
    onEnvelope?(
      envelope: KafkaAgentEventEnvelope,
      position: KafkaAgentEventPosition,
    ): Promise<void>;
    onEnvelopeGroup?(
      values: readonly Readonly<{
        envelope: KafkaAgentEventEnvelope;
        position: KafkaAgentEventPosition;
      }>[],
    ): Promise<void>;
    partitionsConsumedConcurrently?: number;
  }>;

export type KafkaAcceptedAgentEventConsumerOptions = KafkaAgentEventLogOptions &
  Readonly<{
    groupId: string;
    onEnvelope?(
      envelope: KafkaAcceptedAgentEventEnvelope,
      position: KafkaAgentEventPosition,
    ): Promise<void>;
    onEnvelopeGroup?(
      values: readonly Readonly<{
        envelope: KafkaAcceptedAgentEventEnvelope;
        position: KafkaAgentEventPosition;
      }>[],
    ): Promise<void>;
    partitionsConsumedConcurrently?: number;
  }>;

function bounded(value: string, name: string, maximum = 249): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function kafka(options: KafkaAgentEventLogOptions): InstanceType<typeof Kafka> {
  if (options.brokers.length < 1 || options.brokers.length > 64) {
    throw new TypeError("Kafka brokers are invalid");
  }
  return new Kafka({
    "bootstrap.servers": options.brokers.map((value) => bounded(value, "broker", 512)).join(","),
    "client.id": bounded(options.clientId, "clientId"),
    log_level: 0,
    ...(options.security === undefined
      ? {}
      : {
          "security.protocol": "sasl_ssl",
          "sasl.mechanisms": "SCRAM-SHA-512",
          "sasl.username": bounded(options.security.username, "Kafka username", 256),
          "sasl.password": bounded(options.security.password, "Kafka password", 512),
          "ssl.ca.pem": options.security.ca,
        }),
  });
}

function publications(value: unknown): readonly (EventPublishMessage | EventPublishBatchMessage)[] {
  const parsed = parseSupervisorToControlMessage(value);
  if (parsed.type !== "event.publish" && parsed.type !== "event.publish_batch") {
    throw new TypeError("Kafka event producer accepts only event publications");
  }
  return [parsed];
}

function firstEvent(publication: EventPublishMessage | EventPublishBatchMessage) {
  return publication.type === "event.publish"
    ? publication.payload.event
    : publication.payload.events[0]!;
}

function lastEvent(publication: EventPublishMessage | EventPublishBatchMessage) {
  return publication.type === "event.publish"
    ? publication.payload.event
    : publication.payload.events.at(-1)!;
}

export function parseKafkaAgentEventEnvelope(
  value: Buffer | string | null,
): KafkaAgentEventEnvelope {
  if (value === null) throw new TypeError("Kafka Agent event envelope is empty");
  const parsed = JSON.parse(value.toString()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Kafka Agent event envelope is invalid");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.publications) ||
    candidate.publications.length < 1 ||
    candidate.publications.length > 64
  ) {
    throw new TypeError("Kafka Agent event envelope is invalid");
  }
  const decoded = candidate.publications.flatMap(publications);
  const sessionId = firstEvent(decoded[0]!).sessionId;
  if (decoded.some((publication) => firstEvent(publication).sessionId !== sessionId)) {
    throw new TypeError("Kafka Agent event envelope mixes Sessions");
  }
  return Object.freeze({ schemaVersion: 1, publications: Object.freeze(decoded) });
}

export function parseKafkaAcceptedAgentEventEnvelope(
  value: Buffer | string | null,
): KafkaAcceptedAgentEventEnvelope {
  if (value === null) throw new TypeError("Kafka accepted Agent event envelope is empty");
  const parsed = JSON.parse(value.toString()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Kafka accepted Agent event envelope is invalid");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.tenantId !== "string" ||
    candidate.tenantId.length < 1 ||
    candidate.tenantId.length > 256 ||
    !Array.isArray(candidate.publications) ||
    candidate.publications.length < 1 ||
    candidate.publications.length > 64
  ) {
    throw new TypeError("Kafka accepted Agent event envelope is invalid");
  }
  const decoded = candidate.publications.map((publication) => {
    if (typeof publication !== "object" || publication === null || Array.isArray(publication)) {
      throw new TypeError("Kafka accepted Agent event publication is invalid");
    }
    const message = publication as Record<string, unknown>;
    const payload = message.payload;
    if (
      message.protocolVersion !== 1 ||
      (message.type !== "event.publish" && message.type !== "event.publish_batch") ||
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new TypeError("Kafka accepted Agent event publication is invalid");
    }
    const body = payload as Record<string, unknown>;
    const events = message.type === "event.publish" ? [body.event] : body.events;
    if (
      typeof body.leaseId !== "string" ||
      !Number.isSafeInteger(body.fencingToken) ||
      typeof body.runId !== "string" ||
      typeof body.attemptId !== "string" ||
      !Array.isArray(events) ||
      events.length < 1 ||
      events.length > 128 ||
      events.some((event) => {
        if (typeof event !== "object" || event === null || Array.isArray(event)) return true;
        const candidateEvent = event as Record<string, unknown>;
        return (
          candidateEvent.schemaVersion !== 1 ||
          typeof candidateEvent.eventId !== "string" ||
          typeof candidateEvent.sessionId !== "string" ||
          !Number.isSafeInteger(candidateEvent.seq) ||
          typeof candidateEvent.type !== "string" ||
          typeof candidateEvent.payload !== "object" ||
          candidateEvent.payload === null
        );
      })
    ) {
      throw new TypeError("Kafka accepted Agent event publication is invalid");
    }
    return message as EventPublishMessage | EventPublishBatchMessage;
  });
  const sessionId = firstEvent(decoded[0]!).sessionId;
  if (decoded.some((publication) => firstEvent(publication).sessionId !== sessionId)) {
    throw new TypeError("Kafka accepted Agent event envelope mixes Sessions");
  }
  return Object.freeze({
    schemaVersion: 1,
    tenantId: candidate.tenantId,
    publications: Object.freeze(decoded),
  });
}

export class KafkaAgentEventProducer implements DurableEventIngestor, DurableEventGroupIngestor {
  readonly #topic: string;
  readonly #producer: Producer;
  readonly #acceptedBarrier: PostgresAcceptedEventBarrier | undefined;
  #connected: Promise<void> | undefined;
  #closed = false;

  constructor(options: KafkaAgentEventProducerOptions) {
    this.#topic = bounded(options.topic, "topic");
    this.#acceptedBarrier = options.acceptedBarrier;
    this.#producer = kafka(options).producer({
      "allow.auto.create.topics": false,
      "enable.idempotence": true,
      "max.in.flight.requests.per.connection": 5,
      "request.timeout.ms": 10_000,
      "delivery.timeout.ms": 30_000,
      "linger.ms": 5,
      acks: -1,
      "compression.codec": CompressionTypes.GZIP,
    });
    this.#producer.logger().setLogLevel(logLevel.NOTHING);
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    return (await this.ingestGroup([value]))[0]!;
  }

  async ingestGroup(values: readonly unknown[]): Promise<readonly EventAckMessage[]> {
    if (this.#closed) throw new Error("Kafka Agent event producer is closed");
    if (values.length < 1 || values.length > 2_048) {
      throw new TypeError("Kafka Agent event group is invalid");
    }
    const decoded = values.map((value) => publications(value)[0]!);
    await this.#connect();
    await this.#producer.send({
      topic: this.#topic,
      messages: decoded.map((publication) => {
        const event = firstEvent(publication);
        const envelope: KafkaAgentEventEnvelope = {
          schemaVersion: 1,
          publications: [publication],
        };
        return {
          key: event.sessionId,
          value: JSON.stringify(envelope),
          headers: {
            "pi-cloud-schema": "agent-events-v1",
            "pi-cloud-run": publication.payload.runId,
            "pi-cloud-attempt": publication.payload.attemptId,
          },
        };
      }),
    });
    if (this.#acceptedBarrier !== undefined) {
      await Promise.all(decoded.map((publication) => this.#acceptedBarrier!.wait(publication)));
    }
    const now = new Date().toISOString();
    return decoded.map((publication) => ({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: now,
      type: "event.ack",
      payload: {
        sessionId: firstEvent(publication).sessionId,
        leaseId: publication.payload.leaseId,
        fencingToken: publication.payload.fencingToken,
        acknowledgedThroughSeq: lastEvent(publication).seq,
      },
    }));
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

/** Publishes only events already validated against PostgreSQL execution authority. */
export class KafkaAcceptedAgentEventProducer {
  readonly #topic: string;
  readonly #producer: Producer;
  #connected: Promise<void> | undefined;
  #closed = false;

  constructor(options: KafkaAgentEventLogOptions) {
    this.#topic = bounded(options.topic, "topic");
    this.#producer = kafka(options).producer({
      "allow.auto.create.topics": false,
      "enable.idempotence": true,
      "max.in.flight.requests.per.connection": 5,
      "request.timeout.ms": 10_000,
      "delivery.timeout.ms": 30_000,
      "linger.ms": 5,
      acks: -1,
      "compression.codec": CompressionTypes.GZIP,
    });
    this.#producer.logger().setLogLevel(logLevel.NOTHING);
  }

  async append(envelope: KafkaAcceptedAgentEventEnvelope): Promise<void> {
    await this.appendGroup([envelope]);
  }

  async appendGroup(envelopes: readonly KafkaAcceptedAgentEventEnvelope[]): Promise<void> {
    if (this.#closed) throw new Error("Kafka accepted Agent event producer is closed");
    if (envelopes.length < 1 || envelopes.length > 2_048) {
      throw new TypeError("Kafka accepted Agent event group is invalid");
    }
    const parsed = envelopes;
    for (const envelope of parsed) {
      if (
        envelope.schemaVersion !== 1 ||
        envelope.tenantId.length < 1 ||
        envelope.publications.length < 1
      ) {
        throw new TypeError("Kafka accepted Agent event envelope is invalid");
      }
    }
    await this.#connect();
    await this.#producer.send({
      topic: this.#topic,
      messages: parsed.map((envelope) => {
        const first = firstEvent(envelope.publications[0]!);
        return {
          key: first.sessionId,
          value: JSON.stringify(envelope),
          headers: {
            "pi-cloud-schema": "accepted-agent-events-v1",
            "pi-cloud-tenant": envelope.tenantId,
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

export class PostgresAgentEventAuthority {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: { database: Kysely<Database>; clock?: () => Date }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async validate(
    envelope: KafkaAgentEventEnvelope,
  ): Promise<KafkaAcceptedAgentEventEnvelope | undefined> {
    const first = envelope.publications[0]!;
    const identity = first.payload;
    if (
      envelope.publications.some(
        (publication) =>
          publication.payload.runId !== identity.runId ||
          publication.payload.attemptId !== identity.attemptId ||
          publication.payload.leaseId !== identity.leaseId ||
          publication.payload.fencingToken !== identity.fencingToken ||
          publication.payload.commandId !== identity.commandId,
      )
    ) {
      return undefined;
    }
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError("Kafka event authority clock returned an invalid Date");
    }
    const event = firstEvent(first);
    const row = await this.#database
      .selectFrom("runs as run")
      .innerJoin("run_attempts as attempt", (join) =>
        join
          .onRef("attempt.tenant_id", "=", "run.tenant_id")
          .onRef("attempt.run_id", "=", "run.id")
          .on("attempt.id", "=", identity.attemptId),
      )
      .innerJoin("commands as command", (join) =>
        join
          .onRef("command.tenant_id", "=", "run.tenant_id")
          .onRef("command.id", "=", "run.command_id"),
      )
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "run.tenant_id")
          .onRef("session_row.id", "=", "run.session_id"),
      )
      .innerJoin("turns as turn", (join) =>
        join.onRef("turn.tenant_id", "=", "run.tenant_id").onRef("turn.id", "=", "run.turn_id"),
      )
      .innerJoin("session_leases as lease", (join) =>
        join
          .onRef("lease.session_id", "=", "run.session_id")
          .on("lease.lease_id", "=", identity.leaseId),
      )
      .select([
        "run.tenant_id as tenantId",
        "run.current_attempt_id as currentAttemptId",
        "run.state as runState",
        "attempt.state as attemptState",
        "attempt.claim_expires_at as claimExpiresAt",
        "attempt.lease_id as attemptLeaseId",
        "attempt.fencing_token as attemptFence",
        "command.state as commandState",
        "command.id as commandId",
        "session_row.state as sessionState",
        "session_row.last_fencing_token as sessionFence",
        "turn.state as turnState",
        "lease.fencing_token as leaseFence",
        "lease.valid_until as leaseValidUntil",
      ])
      .where("run.id", "=", identity.runId)
      .where("run.session_id", "=", event.sessionId)
      .where("run.turn_id", "=", event.turnId!)
      .executeTakeFirst();
    const activeRunStates = new Set([
      "provisioning",
      "restoring",
      "running",
      "checkpointing",
      "cancel_requested",
    ]);
    const activeAttemptStates = new Set([
      "provisioning",
      "restoring",
      "running",
      "checkpointing",
      "cancel_requested",
    ]);
    const activeSessionStates = new Set(["running", "waiting_approval", "cancelling"]);
    const activeTurnStates = new Set(["running", "waiting_approval", "cancelling"]);
    if (
      row === undefined ||
      row.currentAttemptId !== identity.attemptId ||
      !activeRunStates.has(row.runState) ||
      !activeAttemptStates.has(row.attemptState) ||
      row.commandState !== "acknowledged" ||
      row.commandId !== identity.commandId ||
      !activeSessionStates.has(row.sessionState) ||
      !activeTurnStates.has(row.turnState) ||
      row.attemptLeaseId !== identity.leaseId ||
      Number(row.attemptFence) !== identity.fencingToken ||
      Number(row.sessionFence) !== identity.fencingToken ||
      Number(row.leaseFence) !== identity.fencingToken ||
      new Date(row.claimExpiresAt).valueOf() <= now.valueOf() ||
      new Date(row.leaseValidUntil).valueOf() <= now.valueOf()
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      tenantId: row.tenantId,
      publications: envelope.publications,
    };
  }

  async confirmAccepted(envelope: KafkaAcceptedAgentEventEnvelope): Promise<void> {
    const first = envelope.publications[0]!;
    const lastSequence = Math.max(
      ...envelope.publications.map((publication) => lastEvent(publication).seq),
    );
    const result = await this.#database
      .updateTable("run_attempts")
      .set({ last_event_seq: lastSequence, updated_at: this.#clock() })
      .where("tenant_id", "=", envelope.tenantId)
      .where("run_id", "=", first.payload.runId)
      .where("id", "=", first.payload.attemptId)
      .where("lease_id", "=", first.payload.leaseId)
      .where("fencing_token", "=", String(first.payload.fencingToken))
      .where("state", "in", [
        "provisioning",
        "restoring",
        "running",
        "checkpointing",
        "cancel_requested",
      ])
      .where("last_event_seq", "<=", String(lastSequence))
      .executeTakeFirst();
    if (result.numUpdatedRows === 1n) return;
    const duplicate = await this.#database
      .selectFrom("run_attempts")
      .select("last_event_seq")
      .where("tenant_id", "=", envelope.tenantId)
      .where("run_id", "=", first.payload.runId)
      .where("id", "=", first.payload.attemptId)
      .executeTakeFirst();
    if (duplicate === undefined || Number(duplicate.last_event_seq) < lastSequence) {
      throw new Error("Accepted Agent event lost its RunAttempt authority");
    }
  }
}

/** Worker-side barrier: a raw broker ACK is not yet safe to expose as accepted. */
export class PostgresAcceptedEventBarrier {
  readonly #database: Kysely<Database>;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;

  constructor(options: {
    database: Kysely<Database>;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) {
    this.#database = options.database;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 10;
  }

  async wait(publication: EventPublishMessage | EventPublishBatchMessage): Promise<void> {
    const throughSequence = lastEvent(publication).seq;
    const deadline = Date.now() + this.#timeoutMs;
    while (true) {
      const row = await this.#database
        .selectFrom("run_attempts")
        .select(["last_event_seq", "state", "lease_id", "fencing_token"])
        .where("run_id", "=", publication.payload.runId)
        .where("id", "=", publication.payload.attemptId)
        .executeTakeFirst();
      if (
        row !== undefined &&
        row.lease_id === publication.payload.leaseId &&
        Number(row.fencing_token) === publication.payload.fencingToken &&
        Number(row.last_event_seq) >= throughSequence
      ) {
        return;
      }
      if (
        row === undefined ||
        ["completed", "failed", "cancelled", "timed_out", "superseded"].includes(row.state)
      ) {
        throw new Error("Agent event was not accepted before RunAttempt authority ended");
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the accepted Agent event projection");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
  }
}

export class KafkaAgentEventConsumer {
  readonly #topic: string;
  readonly #consumer: Consumer;
  readonly #onEnvelope: KafkaAgentEventConsumerOptions["onEnvelope"];
  readonly #onEnvelopeGroup: KafkaAgentEventConsumerOptions["onEnvelopeGroup"];
  readonly #concurrency: number;
  #started = false;
  #closed = false;
  #failure: unknown;
  #run: Promise<void> | undefined;

  constructor(options: KafkaAgentEventConsumerOptions) {
    this.#topic = bounded(options.topic, "topic");
    this.#onEnvelope = options.onEnvelope;
    this.#onEnvelopeGroup = options.onEnvelopeGroup;
    if ((this.#onEnvelope === undefined) === (this.#onEnvelopeGroup === undefined)) {
      throw new TypeError("Kafka accepted consumer requires exactly one delivery handler");
    }
    if ((this.#onEnvelope === undefined) === (this.#onEnvelopeGroup === undefined)) {
      throw new TypeError("Kafka Agent consumer requires exactly one delivery handler");
    }
    this.#concurrency = options.partitionsConsumedConcurrently ?? 4;
    this.#consumer = kafka(options).consumer({
      "group.id": bounded(options.groupId, "groupId"),
      "allow.auto.create.topics": false,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
    });
    this.#consumer.logger().setLogLevel(logLevel.NOTHING);
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) throw new Error("Kafka Agent consumer cannot start");
    await this.#consumer.connect();
    await this.#consumer.subscribe({ topics: [this.#topic] });
    this.#started = true;
    const delivery =
      this.#onEnvelopeGroup === undefined
        ? {
            partitionsConsumedConcurrently: this.#concurrency,
            eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
              await this.#onEnvelope!(parseKafkaAgentEventEnvelope(message.value), {
                topic,
                partition,
                offset: message.offset,
              });
              await this.#consumer.commitOffsets([
                { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
              ]);
            },
          }
        : {
            partitionsConsumedConcurrently: this.#concurrency,
            eachBatchAutoResolve: false,
            eachBatch: async ({ batch, resolveOffset }: EachBatchPayload) => {
              const values = batch.messages.map((message) => ({
                envelope: parseKafkaAgentEventEnvelope(message.value),
                position: {
                  topic: batch.topic,
                  partition: batch.partition,
                  offset: message.offset,
                },
              }));
              await this.#onEnvelopeGroup!(values);
              const last = batch.messages.at(-1);
              if (last !== undefined) {
                resolveOffset(last.offset);
                await this.#consumer.commitOffsets([
                  {
                    topic: batch.topic,
                    partition: batch.partition,
                    offset: (BigInt(last.offset) + 1n).toString(),
                  },
                ]);
              }
            },
          };
    this.#run = this.#consumer.run(delivery).catch((error: unknown) => {
      this.#failure = error;
    });
  }

  checkHealth(): void {
    if (!this.#started || this.#closed || this.#failure !== undefined) {
      throw new Error("Kafka Agent consumer is not healthy");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#started) return;
    await this.#consumer.disconnect();
    await this.#run;
  }
}

export class KafkaAcceptedAgentEventConsumer {
  readonly #topic: string;
  readonly #consumer: Consumer;
  readonly #admin: Admin;
  readonly #onEnvelope: KafkaAcceptedAgentEventConsumerOptions["onEnvelope"];
  readonly #onEnvelopeGroup: KafkaAcceptedAgentEventConsumerOptions["onEnvelopeGroup"];
  readonly #concurrency: number;
  #started = false;
  #closed = false;
  #failure: unknown;
  #run: Promise<void> | undefined;
  #catchUpTargets = new Map<number, bigint>();
  #catchUpResolve: (() => void) | undefined;

  constructor(options: KafkaAcceptedAgentEventConsumerOptions) {
    this.#topic = bounded(options.topic, "topic");
    this.#onEnvelope = options.onEnvelope;
    this.#onEnvelopeGroup = options.onEnvelopeGroup;
    this.#concurrency = options.partitionsConsumedConcurrently ?? 4;
    const client = kafka(options);
    this.#consumer = client.consumer({
      "group.id": bounded(options.groupId, "groupId"),
      "allow.auto.create.topics": false,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
    });
    this.#admin = client.admin();
    this.#consumer.logger().setLogLevel(logLevel.NOTHING);
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) throw new Error("Kafka accepted consumer cannot start");
    await this.#admin.connect();
    const offsets = await this.#admin.fetchTopicOffsets(this.#topic, {
      isolationLevel: IsolationLevel.READ_COMMITTED,
    });
    await this.#admin.disconnect();
    this.#catchUpTargets = new Map(
      offsets
        .map((entry) => [entry.partition, BigInt(entry.high) - 1n] as const)
        .filter(([, target]) => target >= 0n),
    );
    const caughtUp = new Promise<void>((resolve) => {
      this.#catchUpResolve = resolve;
      if (this.#catchUpTargets.size === 0) resolve();
    });
    await this.#consumer.connect();
    await this.#consumer.subscribe({ topics: [this.#topic] });
    this.#started = true;
    const observeCatchUp = (partition: number, offset: string): void => {
      const target = this.#catchUpTargets.get(partition);
      if (target !== undefined && BigInt(offset) >= target) {
        this.#catchUpTargets.delete(partition);
        if (this.#catchUpTargets.size === 0) this.#catchUpResolve?.();
      }
    };
    const delivery =
      this.#onEnvelopeGroup === undefined
        ? {
            partitionsConsumedConcurrently: this.#concurrency,
            eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
              await this.#onEnvelope!(parseKafkaAcceptedAgentEventEnvelope(message.value), {
                topic,
                partition,
                offset: message.offset,
              });
              observeCatchUp(partition, message.offset);
              await this.#consumer.commitOffsets([
                { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
              ]);
            },
          }
        : {
            partitionsConsumedConcurrently: this.#concurrency,
            eachBatchAutoResolve: false,
            eachBatch: async ({ batch, resolveOffset }: EachBatchPayload) => {
              const values = batch.messages.map((message) => ({
                envelope: parseKafkaAcceptedAgentEventEnvelope(message.value),
                position: {
                  topic: batch.topic,
                  partition: batch.partition,
                  offset: message.offset,
                },
              }));
              await this.#onEnvelopeGroup!(values);
              const last = batch.messages.at(-1);
              if (last !== undefined) {
                observeCatchUp(batch.partition, last.offset);
                resolveOffset(last.offset);
                await this.#consumer.commitOffsets([
                  {
                    topic: batch.topic,
                    partition: batch.partition,
                    offset: (BigInt(last.offset) + 1n).toString(),
                  },
                ]);
              }
            },
          };
    this.#run = this.#consumer.run(delivery).catch((error: unknown) => {
      this.#failure = error;
      this.#catchUpResolve?.();
    });
    await Promise.race([
      caughtUp,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Kafka accepted event replay did not catch up before readiness")),
          30_000,
        );
        timer.unref();
      }),
    ]);
    if (this.#failure !== undefined) throw this.#failure;
  }

  checkHealth(): void {
    if (!this.#started || this.#closed || this.#failure !== undefined) {
      throw new Error("Kafka accepted Agent event consumer is not healthy");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#started) return;
    await this.#consumer.disconnect();
    await this.#run;
  }
}

/** Raw -> authority check -> accepted. Raw offsets advance only after accepted broker ACK. */
export class KafkaAgentEventAuthorityProjector {
  readonly #consumer: KafkaAgentEventConsumer;

  constructor(
    options: KafkaAgentEventLogOptions & {
      groupId: string;
      authority: PostgresAgentEventAuthority;
      accepted: KafkaAcceptedAgentEventProducer;
    },
  ) {
    this.#consumer = new KafkaAgentEventConsumer({
      ...options,
      groupId: options.groupId,
      onEnvelopeGroup: async (values) => {
        const accepted = (
          await Promise.all(values.map(({ envelope }) => options.authority.validate(envelope)))
        ).filter((envelope): envelope is KafkaAcceptedAgentEventEnvelope => envelope !== undefined);
        if (accepted.length === 0) return;
        await options.accepted.appendGroup(accepted);
        await Promise.all(accepted.map((envelope) => options.authority.confirmAccepted(envelope)));
      },
    });
  }

  start(): Promise<void> {
    return this.#consumer.start();
  }

  checkHealth(): void {
    this.#consumer.checkHealth();
  }

  close(): Promise<void> {
    return this.#consumer.close();
  }
}

/** Relays the transactionally-created terminal outbox into the accepted topic. */
export class KafkaTerminalEventOutboxRelay {
  readonly #database: Kysely<Database>;
  readonly #accepted: KafkaAcceptedAgentEventProducer;
  readonly #pollIntervalMs: number;
  #abort: AbortController | undefined;
  #task: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: {
    database: Kysely<Database>;
    accepted: KafkaAcceptedAgentEventProducer;
    pollIntervalMs?: number;
  }) {
    this.#database = options.database;
    this.#accepted = options.accepted;
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 5) {
      throw new TypeError("Terminal event relay poll interval is invalid");
    }
  }

  start(): void {
    if (this.#task !== undefined) throw new Error("Terminal event relay is already running");
    this.#abort = new AbortController();
    this.#task = this.#run(this.#abort.signal).catch((error: unknown) => {
      this.#failure = error;
    });
  }

  async dispatchOne(): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("outbox")
        .select(["id", "payload", "attempts"])
        .where("topic", "=", SESSION_TERMINAL_EVENT_OUTBOX_TOPIC)
        .where("published_at", "is", null)
        .where("available_at", "<=", new Date())
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return false;
      const envelope = parseKafkaAcceptedAgentEventEnvelope(
        Buffer.from(JSON.stringify(row.payload)),
      );
      await this.#accepted.append(envelope);
      const result = await transaction
        .updateTable("outbox")
        .set({
          attempts: sql<number>`${sql.ref("attempts")} + 1`,
          published_at: new Date(),
          last_error: null,
        })
        .where("id", "=", row.id)
        .where("published_at", "is", null)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw new Error("Terminal event outbox claim was lost");
      return true;
    });
  }

  checkHealth(): void {
    if (this.#task === undefined || this.#failure !== undefined) {
      throw new Error("Terminal event relay is not healthy");
    }
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    await this.#task;
    this.#task = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const dispatched = await this.dispatchOne();
      if (dispatched) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#pollIntervalMs);
        timer.unref();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
