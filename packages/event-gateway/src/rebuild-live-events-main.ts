import { createDatabase } from "@pi-cloud/database";
import { ValkeyLiveSessionEventStore } from "@pi-cloud/runtime-core/live-session-event-store";
import { loadEventGatewayProductionConfig } from "./production-config.ts";
import { rebuildLiveEventsFromKafka } from "./live-event-rebuild.ts";

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
  try {
    const report = await rebuildLiveEventsFromKafka({
      database,
      liveEvents,
      kafka: {
        ...config.kafka,
        clientId: `${config.kafka.clientId}-live-rebuild`,
      },
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await liveEvents.close().catch(() => undefined);
    await database.destroy().catch(() => undefined);
  }
}

rebuildLiveEvents().catch(() => {
  process.stderr.write("PiCloud live-event rebuild failed\n");
  process.exitCode = 1;
});
