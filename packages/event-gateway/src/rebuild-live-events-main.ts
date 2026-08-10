import { createDatabase } from "@agent-dock/database";
import { ValkeyLiveSessionEventStore } from "@agent-dock/runtime-core/live-session-event-store";
import { parseWorkerEventLogEnvelope } from "@agent-dock/runtime-core/worker-event-log";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { loadEventGatewayProductionConfig } from "./production-config.ts";

const { Kafka, logLevel } = KafkaJS;

/**
 * Rebuilds an empty Valkey live-event read model from Kafka's retained log.
 * Stop the normal Event Gateway projector and point this process at the fresh
 * Valkey instance before running it; completed canonical Turns remain in PG.
 */
async function rebuildLiveEvents(): Promise<void> {
  const config = await loadEventGatewayProductionConfig();
  if (config.kafka === undefined || config.liveEventStoreUrl === undefined) {
    throw new Error("Kafka and Valkey must be configured for live-event rebuild");
  }
  const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 4 });
  const liveEvents = new ValkeyLiveSessionEventStore({ url: config.liveEventStoreUrl });
  const kafka = new Kafka({
    "bootstrap.servers": config.kafka.brokers.join(","),
    "client.id": `${config.kafka.clientId}-live-rebuild`,
    ...(config.kafka.security === undefined
      ? {}
      : {
          "security.protocol": "sasl_ssl",
          "sasl.mechanisms": "SCRAM-SHA-512",
          "sasl.username": config.kafka.security.username,
          "sasl.password": config.kafka.security.password,
          "ssl.ca.pem": config.kafka.security.ca,
        }),
  });
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
    await Promise.all([admin.connect(), liveEvents.checkHealth()]);
    const topicOffsets = await admin.fetchTopicOffsets(config.kafka.topic);
    const remaining = new Map(
      topicOffsets
        .map((offset) => [offset.partition, BigInt(offset.offset)] as const)
        .filter(([, offset]) => offset > 0n),
    );
    if (remaining.size === 0) {
      process.stdout.write('{"rebuilt":true,"envelopes":0,"events":0}\n');
      return;
    }
    let resolveComplete!: () => void;
    let rejectComplete!: (error: unknown) => void;
    const complete = new Promise<void>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    await consumer.connect();
    await consumer.subscribe({ topics: [config.kafka.topic] });
    const run = consumer
      .run({
        partitionsConsumedConcurrently: 8,
        eachMessage: async ({ partition, message }) => {
          const envelope = parseWorkerEventLogEnvelope(message.value);
          const sessionId = envelope.messages[0]!.payload.event.sessionId;
          let cursor = cursorCache.get(sessionId);
          if (!cursorCache.has(sessionId)) {
            const row = await database
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
                    replayFloor: Number(row.replayFloor),
                    persistedThrough: Number(row.persistedThrough),
                  };
            if (
              cursor !== undefined &&
              (!Number.isSafeInteger(cursor.replayFloor) ||
                !Number.isSafeInteger(cursor.persistedThrough) ||
                cursor.replayFloor < 0 ||
                cursor.persistedThrough < cursor.replayFloor)
            ) {
              throw new Error("Live-event rebuild found an invalid Session cursor");
            }
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
              await liveEvents.append({
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
            10 * 60_000,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    await consumer.stop();
    await run;
    process.stdout.write(`${JSON.stringify({ rebuilt: true, envelopes, events })}\n`);
  } finally {
    await consumer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
    await liveEvents.close().catch(() => undefined);
    await database.destroy().catch(() => undefined);
  }
}

rebuildLiveEvents().catch(() => {
  process.stderr.write("AgentDock live-event rebuild failed\n");
  process.exitCode = 1;
});
