import type { Database } from "@pi-cloud/database";
import type { LiveSessionEventStore } from "@pi-cloud/runtime-core/live-session-event-store";
import { parseWorkerEventLogEnvelope } from "@pi-cloud/runtime-core/worker-event-envelope";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { sql, type Kysely } from "kysely";
import {
  findMissingLiveEventSessions,
  mapConcurrent,
  retainedKafkaPartitionEnds,
  safeKafkaSequence,
} from "./live-event-repair-state.ts";

export {
  findMissingLiveEventSessions,
  retainedKafkaPartitionEnds,
} from "./live-event-repair-state.ts";

const { Kafka, logLevel } = KafkaJS;

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

/** Replays only the still-retained per-Session suffix from Kafka into Valkey. */
export async function rebuildLiveEventsFromKafka(
  options: LiveEventRebuildOptions,
): Promise<LiveEventRebuildReport> {
  const kafka = kafkaClient(options.kafka);
  const admin = kafka.admin();
  const consumer = kafka.consumer({
    "group.id": `pi-cloud-live-rebuild-${globalThis.crypto.randomUUID()}`,
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
    const remaining = new Map(retainedKafkaPartitionEnds(topicOffsets));
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
                    replayFloor: safeKafkaSequence(row.replayFloor, "Replay floor"),
                    persistedThrough: safeKafkaSequence(row.persistedThrough, "Persisted sequence"),
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
    await sql`select pg_advisory_lock(hashtext('pi-cloud'), hashtext('live-event-repair-v1'))`.execute(
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
      await sql`select pg_advisory_unlock(hashtext('pi-cloud'), hashtext('live-event-repair-v1'))`.execute(
        connection,
      );
    }
  });
}
