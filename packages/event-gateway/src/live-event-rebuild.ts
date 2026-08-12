import type { Database } from "@agent-dock/database";
import type { LiveSessionEventStore } from "@agent-dock/runtime-core/live-session-event-store";
import { parseWorkerEventLogEnvelope } from "@agent-dock/runtime-core/worker-event-log";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { sql, type Kysely } from "kysely";

const { Kafka, logLevel } = KafkaJS;
const PAGE_SIZE = 500;

export type LiveEventRebuildKafkaConfiguration = Readonly<{
  brokers: readonly string[];
  clientId: string;
  topic: string;
  security?: Readonly<{ ca: string; username: string; password: string }>;
}>;

export type LiveEventRebuildOptions = Readonly<{
  database: Kysely<Database>;
  liveEvents: LiveSessionEventStore;
  kafka: LiveEventRebuildKafkaConfiguration;
  timeoutMs?: number;
}>;

export type LiveEventRebuildReport = Readonly<{
  rebuilt: true;
  envelopes: number;
  events: number;
}>;

export type LiveEventRepairReport = Readonly<{
  repaired: boolean;
  missingSessions: number;
  rebuild?: LiveEventRebuildReport;
}>;

type MissingLiveSession = Readonly<{
  tenantId: string;
  sessionId: string;
  replayFloor: number;
  liveThrough: number;
}>;

function safeSequence(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${description} is outside the non-negative safe integer range`);
  }
  return parsed;
}

function kafkaClient(configuration: LiveEventRebuildKafkaConfiguration) {
  return new Kafka({
    "bootstrap.servers": configuration.brokers.join(","),
    "client.id": configuration.clientId,
    ...(configuration.security === undefined
      ? {}
      : {
          "security.protocol": "sasl_ssl",
          "sasl.mechanisms": "SCRAM-SHA-512",
          "sasl.username": configuration.security.username,
          "sasl.password": configuration.security.password,
          "ssl.ca.pem": configuration.security.ca,
        }),
  });
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        await operation(values[index]!);
      }
    }),
  );
}

/** Finds durable live ranges whose first retained event is absent from Valkey. */
export async function findMissingLiveEventSessions(
  database: Kysely<Database>,
  liveEvents: LiveSessionEventStore,
): Promise<readonly MissingLiveSession[]> {
  const missing: MissingLiveSession[] = [];
  let afterSessionId: string | undefined;
  while (true) {
    let query = database
      .selectFrom("sessions as session_row")
      .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
      .leftJoin("session_terminal_events as terminal", (join) =>
        join
          .onRef("terminal.tenant_id", "=", "session_row.tenant_id")
          .onRef("terminal.session_id", "=", "session_row.id")
          .onRef("terminal.seq", "=", "cursor.last_projected_seq"),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.tenant_id as tenantId",
        "cursor.replay_floor_seq as replayFloor",
        "cursor.last_projected_seq as projectedThrough",
        "terminal.seq as terminalSequence",
      ])
      .whereRef("cursor.last_projected_seq", ">", "cursor.replay_floor_seq")
      .orderBy("session_row.id", "asc")
      .limit(PAGE_SIZE);
    if (afterSessionId !== undefined) query = query.where("session_row.id", ">", afterSessionId);
    const rows = await query.execute();
    if (rows.length === 0) break;
    const candidates = rows
      .map((row): MissingLiveSession | undefined => {
        const replayFloor = safeSequence(row.replayFloor, "Replay floor");
        const projectedThrough = safeSequence(row.projectedThrough, "Projected sequence");
        const terminalSequence =
          row.terminalSequence === null
            ? undefined
            : safeSequence(row.terminalSequence, "Terminal sequence");
        const liveThrough =
          terminalSequence === projectedThrough ? projectedThrough - 1 : projectedThrough;
        return liveThrough <= replayFloor
          ? undefined
          : { tenantId: row.tenantId, sessionId: row.sessionId, replayFloor, liveThrough };
      })
      .filter((value): value is MissingLiveSession => value !== undefined);
    await mapConcurrent(candidates, 16, async (candidate) => {
      try {
        const first = await liveEvents.readPage(
          candidate.tenantId,
          candidate.sessionId,
          candidate.replayFloor,
          candidate.liveThrough,
          1,
        );
        if (first[0]?.seq !== candidate.replayFloor + 1) missing.push(candidate);
      } catch {
        missing.push(candidate);
      }
    });
    afterSessionId = rows.at(-1)!.sessionId;
  }
  return missing;
}

/** Replays only the still-retained per-Session suffix from Kafka into Valkey. */
export async function rebuildLiveEventsFromKafka(
  options: LiveEventRebuildOptions,
): Promise<LiveEventRebuildReport> {
  const kafka = kafkaClient(options.kafka);
  const admin = kafka.admin();
  const consumer = kafka.consumer({
    "group.id": `agent-dock-live-rebuild-${globalThis.crypto.randomUUID()}`,
    "allow.auto.create.topics": false,
    "auto.offset.reset": "earliest",
    "enable.auto.commit": false,
  });
  consumer.logger().setLogLevel(logLevel.NOTHING);
  const cursorCache = new Map<
    string,
    { tenantId: string; replayFloor: number; persistedThrough: number } | undefined
  >();
  let envelopes = 0;
  let events = 0;
  try {
    await Promise.all([admin.connect(), options.liveEvents.checkHealth?.()]);
    const topicOffsets = await admin.fetchTopicOffsets(options.kafka.topic);
    const remaining = new Map(
      topicOffsets
        .map((offset) => [offset.partition, BigInt(offset.offset)] as const)
        .filter(([, offset]) => offset > 0n),
    );
    if (remaining.size === 0) return { rebuilt: true, envelopes: 0, events: 0 };

    let resolveComplete!: () => void;
    let rejectComplete!: (error: unknown) => void;
    const complete = new Promise<void>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    await consumer.connect();
    await consumer.subscribe({ topics: [options.kafka.topic] });
    const run = consumer
      .run({
        partitionsConsumedConcurrently: 8,
        eachMessage: async ({ partition, message }) => {
          const envelope = parseWorkerEventLogEnvelope(message.value);
          const sessionId = envelope.messages[0]!.payload.event.sessionId;
          let cursor = cursorCache.get(sessionId);
          if (!cursorCache.has(sessionId)) {
            const row = await options.database
              .selectFrom("sessions as session_row")
              .innerJoin(
                "session_event_cursors as event_cursor",
                "event_cursor.session_id",
                "session_row.id",
              )
              .select([
                "session_row.tenant_id as tenantId",
                "event_cursor.replay_floor_seq as replayFloor",
                "event_cursor.last_persisted_seq as persistedThrough",
              ])
              .where("session_row.id", "=", sessionId)
              .executeTakeFirst();
            cursor =
              row === undefined
                ? undefined
                : {
                    tenantId: row.tenantId,
                    replayFloor: safeSequence(row.replayFloor, "Replay floor"),
                    persistedThrough: safeSequence(row.persistedThrough, "Persisted sequence"),
                  };
            cursorCache.set(sessionId, cursor);
          }
          if (cursor !== undefined) {
            if (cursor.tenantId !== envelope.tenantId) {
              throw new Error("Live-event rebuild found a tenant conflict");
            }
            const retained = envelope.messages.filter(({ payload }) => {
              const sequence = payload.event.seq;
              return sequence > cursor!.replayFloor && sequence <= cursor!.persistedThrough;
            });
            if (retained.length > 0) {
              await options.liveEvents.append({
                tenantId: envelope.tenantId,
                sessionId,
                previousSequence: retained[0]!.payload.event.seq - 1,
                messages: retained,
              });
              events += retained.length;
            }
          }
          envelopes += 1;
          const target = remaining.get(partition);
          if (target !== undefined && BigInt(message.offset) + 1n >= target) {
            remaining.delete(partition);
            if (remaining.size === 0) resolveComplete();
          }
        },
      })
      .catch(rejectComplete);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        complete,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Live-event rebuild timed out")),
            options.timeoutMs ?? 10 * 60_000,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    await consumer.stop();
    await run;
    return { rebuilt: true, envelopes, events };
  } finally {
    await consumer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  }
}

/**
 * Serializes startup repair through a PostgreSQL session advisory lock. The
 * supplied database connection must bypass transaction-pooling PgBouncer.
 */
export async function repairLiveEventsIfNeeded(
  options: LiveEventRebuildOptions,
): Promise<LiveEventRepairReport> {
  return options.database.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtext('agent-dock'), hashtext('live-event-repair-v1'))`.execute(
      connection,
    );
    try {
      const missing = await findMissingLiveEventSessions(connection, options.liveEvents);
      if (missing.length === 0) return { repaired: false, missingSessions: 0 };
      await mapConcurrent(missing, 16, (session) =>
        options.liveEvents.resetSession(session.tenantId, session.sessionId),
      );
      const rebuild = await rebuildLiveEventsFromKafka({ ...options, database: connection });
      const unresolved = await findMissingLiveEventSessions(connection, options.liveEvents);
      if (unresolved.length > 0) {
        throw new Error(
          `Kafka retention could not repair ${String(unresolved.length)} live Session streams`,
        );
      }
      return { repaired: true, missingSessions: missing.length, rebuild };
    } finally {
      await sql`select pg_advisory_unlock(hashtext('agent-dock'), hashtext('live-event-repair-v1'))`.execute(
        connection,
      );
    }
  });
}
