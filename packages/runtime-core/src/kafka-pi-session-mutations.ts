import type { Database } from "@pi-cloud/database";
import {
  PostgresPiSessionStorage,
  PostgresRunExecutionAuthority,
  type PiSessionMutationOperation,
  type PiSessionMutationPublisher,
} from "@pi-cloud/pi-session-postgres";
import { SessionError, type Entry, type LaneRecord } from "@earendil-works/pi-agent-core";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { Kysely } from "kysely";

const { CompressionTypes, Kafka, logLevel } = KafkaJS;
type Producer = ReturnType<InstanceType<typeof Kafka>["producer"]>;
type Consumer = ReturnType<InstanceType<typeof Kafka>["consumer"]>;

export type KafkaPiSessionMutationScope = Readonly<{
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  attemptId: string;
  claimOwnerId: string;
  fencingToken: number;
}>;

export type KafkaPiSessionMutationEnvelope = Readonly<{
  schemaVersion: 1;
  mutationId: string;
  scope: KafkaPiSessionMutationScope;
  operation: PiSessionMutationOperation;
  occurredAt: string;
}>;

export type KafkaPiSessionMutationOptions = Readonly<{
  database: Kysely<Database>;
  brokers: readonly string[];
  clientId: string;
  topic: string;
}>;

function bounded(value: string, name: string, maximum = 249): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function kafka(options: KafkaPiSessionMutationOptions): InstanceType<typeof Kafka> {
  return new Kafka({
    "bootstrap.servers": options.brokers.map((value) => bounded(value, "broker", 512)).join(","),
    "client.id": bounded(options.clientId, "clientId"),
    log_level: 0,
  });
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} is invalid`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, description: string, maximum = 4_096): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${description} is invalid`);
  }
  return value;
}

function uuid(value: unknown, description: string): string {
  const candidate = string(value, description, 64);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
  ) {
    throw new TypeError(`${description} is invalid`);
  }
  return candidate;
}

function parseOperation(value: unknown): PiSessionMutationOperation {
  const candidate = object(value, "Pi Session mutation operation");
  switch (candidate.kind) {
    case "create_lane":
      return {
        kind: "create_lane",
        lane: string(candidate.lane, "Pi lane", 256),
        at: candidate.at === null ? null : string(candidate.at, "Pi lane target", 512),
      };
    case "move_lane":
      return {
        kind: "move_lane",
        lane: string(candidate.lane, "Pi lane", 256),
        to: candidate.to === null ? null : string(candidate.to, "Pi lane target", 512),
      };
    case "append_entry":
      return {
        kind: "append_entry",
        entry: structuredClone(object(candidate.entry, "Pi entry")) as PiSessionMutationOperation &
          never,
        lane: string(candidate.lane, "Pi entry lane", 256),
      } as PiSessionMutationOperation;
    case "append_record":
      return {
        kind: "append_record",
        record: structuredClone(
          object(candidate.record, "Pi record"),
        ) as PiSessionMutationOperation & never,
      } as PiSessionMutationOperation;
    case "set_name":
      return { kind: "set_name", name: string(candidate.name, "Pi Session name", 1_024) };
    case "set_label":
      return {
        kind: "set_label",
        id: string(candidate.id, "Pi label target", 512),
        ...(candidate.label === undefined
          ? {}
          : { label: string(candidate.label, "Pi label", 1_024) }),
      };
    default:
      throw new TypeError("Pi Session mutation kind is invalid");
  }
}

export function parseKafkaPiSessionMutationEnvelope(
  value: Buffer | string | null,
): KafkaPiSessionMutationEnvelope {
  if (value === null) throw new TypeError("Pi Session mutation envelope is empty");
  const candidate = object(JSON.parse(value.toString()) as unknown, "Pi Session mutation envelope");
  const scope = object(candidate.scope, "Pi Session mutation scope");
  const fencingToken = Number(scope.fencingToken);
  const occurredAt = string(candidate.occurredAt, "Pi Session mutation timestamp", 64);
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1 ||
    Number.isNaN(new Date(occurredAt).valueOf())
  ) {
    throw new TypeError("Pi Session mutation envelope is invalid");
  }
  return {
    schemaVersion: 1,
    mutationId: uuid(candidate.mutationId, "Pi Session mutation ID"),
    scope: {
      tenantId: uuid(scope.tenantId, "tenant ID"),
      sessionId: string(scope.sessionId, "Session ID", 512),
      turnId: uuid(scope.turnId, "Turn ID"),
      runId: uuid(scope.runId, "Run ID"),
      attemptId: uuid(scope.attemptId, "RunAttempt ID"),
      claimOwnerId: string(scope.claimOwnerId, "claim owner", 256),
      fencingToken,
    },
    operation: parseOperation(candidate.operation),
    occurredAt,
  };
}

/** Shared Worker producer; each active Run receives a cheap scoped publisher. */
export class KafkaPiSessionMutationProducer {
  readonly #database: Kysely<Database>;
  readonly #topic: string;
  readonly #producer: Producer;
  #connected: Promise<void> | undefined;
  #closed = false;

  constructor(options: KafkaPiSessionMutationOptions) {
    this.#database = options.database;
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

  scoped(scope: KafkaPiSessionMutationScope): PiSessionMutationPublisher {
    return { mutate: (operation) => this.#mutate(scope, operation) };
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

  async #mutate(scope: KafkaPiSessionMutationScope, operation: PiSessionMutationOperation) {
    if (this.#closed) throw new Error("Kafka Pi Session mutation producer is closed");
    const mutationId = globalThis.crypto.randomUUID();
    const envelope: KafkaPiSessionMutationEnvelope = {
      schemaVersion: 1,
      mutationId,
      scope,
      operation,
      occurredAt: new Date().toISOString(),
    };
    await this.#connect();
    await this.#producer.send({
      topic: this.#topic,
      messages: [{ key: scope.sessionId, value: JSON.stringify(envelope) }],
    });
    const deadline = Date.now() + 120_000;
    while (true) {
      const result = await this.#database
        .selectFrom("pi_session_mutation_results")
        .select(["state", "result", "error_code", "error_message"])
        .where("mutation_id", "=", mutationId)
        .where("tenant_id", "=", scope.tenantId)
        .where("session_id", "=", scope.sessionId)
        .executeTakeFirst();
      if (result?.state === "completed") return structuredClone(result.result);
      if (result?.state === "failed") {
        throw new SessionError(
          "storage",
          `${result.error_code ?? "storage"}: ${result.error_message ?? "Pi Session mutation failed"}`,
        );
      }
      if (Date.now() >= deadline) throw new Error("Pi Session mutation projection timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  #connect(): Promise<void> {
    this.#connected ??= this.#producer.connect();
    return this.#connected;
  }
}

export class KafkaPiSessionMutationProjector {
  readonly #database: Kysely<Database>;
  readonly #topic: string;
  readonly #consumer: Consumer;
  #run: Promise<void> | undefined;
  #failure: unknown;
  #projectedSinceCleanup = 0;

  constructor(options: KafkaPiSessionMutationOptions & { groupId: string }) {
    this.#database = options.database;
    this.#topic = bounded(options.topic, "topic");
    this.#consumer = kafka(options).consumer({
      "group.id": bounded(options.groupId, "groupId"),
      "allow.auto.create.topics": false,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
    });
    this.#consumer.logger().setLogLevel(logLevel.NOTHING);
  }

  async start(): Promise<void> {
    await this.#consumer.connect();
    await this.#consumer.subscribe({ topics: [this.#topic] });
    this.#run = this.#consumer
      .run({
        partitionsConsumedConcurrently: 4,
        eachMessage: async ({ topic, partition, message }) => {
          await this.#project(parseKafkaPiSessionMutationEnvelope(message.value));
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
    if (this.#run === undefined || this.#failure !== undefined) {
      throw new Error("Kafka Pi Session mutation projector is not healthy");
    }
  }

  async close(): Promise<void> {
    if (this.#run === undefined) return;
    await this.#consumer.disconnect();
    await this.#run;
    this.#run = undefined;
  }

  async #project(envelope: KafkaPiSessionMutationEnvelope): Promise<void> {
    this.#projectedSinceCleanup += 1;
    if (this.#projectedSinceCleanup >= 256) {
      this.#projectedSinceCleanup = 0;
      await this.#database
        .deleteFrom("pi_session_mutation_results")
        .where("expires_at", "<", new Date())
        .execute();
    }
    const existing = await this.#database
      .selectFrom("pi_session_mutation_results")
      .select("mutation_id")
      .where("mutation_id", "=", envelope.mutationId)
      .executeTakeFirst();
    if (existing !== undefined) return;
    const authority = new PostgresRunExecutionAuthority({
      database: this.#database,
      tenantId: envelope.scope.tenantId,
      sessionId: envelope.scope.sessionId,
      runId: envelope.scope.runId,
      attemptId: envelope.scope.attemptId,
      claimOwnerId: envelope.scope.claimOwnerId,
      fencingToken: envelope.scope.fencingToken,
    });
    const storage = new PostgresPiSessionStorage({
      database: this.#database,
      tenantId: envelope.scope.tenantId,
      sessionId: envelope.scope.sessionId,
      turnId: envelope.scope.turnId,
      authority,
      projectedMutationId: envelope.mutationId,
    });
    try {
      const result = await applyOperation(storage, envelope.operation);
      await this.#database
        .insertInto("pi_session_mutation_results")
        .values({
          mutation_id: envelope.mutationId,
          tenant_id: envelope.scope.tenantId,
          session_id: envelope.scope.sessionId,
          run_id: envelope.scope.runId,
          attempt_id: envelope.scope.attemptId,
          state: "completed",
          result: (result ?? null) as Record<string, unknown> | null,
          error_code: null,
          error_message: null,
          expires_at: new Date(Date.now() + 60 * 60_000),
        })
        .onConflict((conflict) => conflict.column("mutation_id").doNothing())
        .executeTakeFirst();
    } catch (error: unknown) {
      if (!(error instanceof SessionError)) throw error;
      await this.#database
        .insertInto("pi_session_mutation_results")
        .values({
          mutation_id: envelope.mutationId,
          tenant_id: envelope.scope.tenantId,
          session_id: envelope.scope.sessionId,
          run_id: envelope.scope.runId,
          attempt_id: envelope.scope.attemptId,
          state: "failed",
          result: null,
          error_code: error.code,
          error_message: error.message,
          expires_at: new Date(Date.now() + 60 * 60_000),
        })
        .onConflict((conflict) => conflict.column("mutation_id").doNothing())
        .executeTakeFirst();
    } finally {
      await authority.close();
    }
  }
}

async function applyOperation(
  storage: PostgresPiSessionStorage,
  operation: PiSessionMutationOperation,
): Promise<Entry | LaneRecord | undefined> {
  switch (operation.kind) {
    case "create_lane":
      await storage.createLane(operation.lane, operation.at);
      return undefined;
    case "move_lane":
      await storage.moveLane(operation.lane, operation.to);
      return undefined;
    case "append_entry":
      return storage.appendEntry(operation.entry, operation.lane);
    case "append_record":
      return storage.appendRecord(operation.record);
    case "set_name":
      await storage.setName(operation.name);
      return undefined;
    case "set_label":
      await storage.setLabel(operation.id, operation.label);
      return undefined;
  }
}
