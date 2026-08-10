import { parseSupervisorToControlMessage, type EventPublishMessage } from "@agent-dock/protocol";
import { KafkaJS } from "@confluentinc/kafka-javascript";

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

export type WorkerEventLogPosition = Readonly<{
  consumerGroup: string;
  topic: string;
  partition: number;
  offset: string;
}>;

export interface WorkerEventLogAppender {
  append(batches: readonly WorkerEventLogBatch[]): Promise<void>;
  checkHealth?(): Promise<void>;
  close?(): Promise<void>;
}

export interface WorkerEventProjectionSink {
  project(envelope: WorkerEventLogEnvelope, position: WorkerEventLogPosition): Promise<void>;
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
      "request.timeout.ms": 10_000,
      "delivery.timeout.ms": 30_000,
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
  readonly #groupId: string;
  readonly #sink: WorkerEventProjectionSink;
  readonly #partitionsConsumedConcurrently: number;
  readonly #consumer: Consumer;
  #started = false;
  #closed = false;
  #runPromise: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: KafkaWorkerEventProjectorOptions) {
    this.#topic = bounded(options.topic, "topic");
    this.#groupId = bounded(options.groupId, "groupId");
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
      "group.id": this.#groupId,
      "allow.auto.create.topics": false,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
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
        eachMessage: async ({ topic, partition, message }) => {
          await this.#projectWithRetry(parseWorkerEventLogEnvelope(message.value), {
            consumerGroup: this.#groupId,
            topic,
            partition,
            offset: message.offset,
          });
          await this.#consumer.commitOffsets([
            { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
          ]);
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

  async #projectWithRetry(
    envelope: WorkerEventLogEnvelope,
    position: WorkerEventLogPosition,
  ): Promise<void> {
    const deadline = Date.now() + 60_000;
    let delayMs = 10;
    while (true) {
      try {
        await this.#sink.project(envelope, position);
        return;
      } catch (error: unknown) {
        const retryable =
          typeof error === "object" &&
          error !== null &&
          "retryable" in error &&
          (error as { retryable?: unknown }).retryable === true;
        if (!retryable || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 1_000);
      }
    }
  }
}
