import { createDatabase } from "@pi-cloud/database";
import { PostgresTenantApiAuthenticator } from "@pi-cloud/control-plane/tenant-identity";
import { WebAuthenticationService } from "@pi-cloud/control-plane/web-authentication";
import { operationalLog, startServiceObservability } from "@pi-cloud/observability";
import { DurableEventStore } from "@pi-cloud/runtime-core/durable-event-store";
import { ValkeyLiveSessionEventStore } from "@pi-cloud/runtime-core/live-session-event-store";
import { ValkeyLiveTurnSnapshotSource } from "@pi-cloud/runtime-core/live-turn-snapshot";
import { PostgresSessionEventNotifications } from "@pi-cloud/runtime-core/postgres-session-event-notifications";
import {
  KafkaWorkerEventLog,
  KafkaWorkerEventProjector,
} from "@pi-cloud/runtime-core/worker-event-log";
import { LiveTerminalTurnProjectionSource } from "@pi-cloud/runtime-core/terminal-turn-projection";
import { pathToFileURL } from "node:url";
import { EventGateway } from "./event-gateway.ts";
import { repairLiveEventsIfNeeded } from "./live-event-rebuild.ts";
import { loadEventGatewayProductionConfig } from "./production-config.ts";

export async function startEventGateway(): Promise<void> {
  const config = await loadEventGatewayProductionConfig();
  const observability = await startServiceObservability({
    serviceName: "pi-cloud-event-gateway",
    defaultMetricsPort: 9467,
  });
  const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 20 });
  const notifications = new PostgresSessionEventNotifications({
    connectionString: config.databaseNotificationUrl,
    applicationName: "pi-cloud-event-gateway",
  });
  const authenticationDefaults = {
    database,
    enabled: false,
    maximumTenants: 1,
    tenantQuotas: {
      maximumProjects: 1,
      maximumSessions: 1,
      maximumUnsettledTurns: 1,
      maximumConcurrentTurns: 1,
      maximumActiveSandboxes: 1,
    },
  } as const;
  const kafkaLog =
    config.kafka === undefined
      ? undefined
      : new KafkaWorkerEventLog({
          brokers: config.kafka.brokers,
          clientId: `${config.kafka.clientId}-producer`,
          topic: config.kafka.topic,
          ...(config.kafka.security === undefined ? {} : { security: config.kafka.security }),
        });
  const liveEvents =
    config.kafka === undefined
      ? undefined
      : new ValkeyLiveSessionEventStore({ url: config.liveEventStoreUrl! });
  const eventStore = new DurableEventStore({
    database,
    eventNotificationPublisher: notifications,
    metrics: observability.metrics,
    ...(kafkaLog === undefined || liveEvents === undefined
      ? {}
      : { workerEventLog: kafkaLog, liveEventStore: liveEvents }),
  });
  const projector =
    config.kafka === undefined
      ? undefined
      : new KafkaWorkerEventProjector({
          brokers: config.kafka.brokers,
          clientId: `${config.kafka.clientId}-projector`,
          topic: config.kafka.topic,
          groupId: config.kafka.groupId,
          sink: eventStore,
          ...(config.kafka.security === undefined ? {} : { security: config.kafka.security }),
        });
  const gateway = new EventGateway({
    database,
    eventLog: eventStore,
    apiAuthenticator: new PostgresTenantApiAuthenticator({ database }),
    webSessionAuthenticator: new WebAuthenticationService(authenticationDefaults),
    notifications,
    ...(projector === undefined || kafkaLog === undefined
      ? {}
      : {
          dependencyReadiness: async () => {
            projector.checkHealth();
            await kafkaLog.checkHealth();
            await liveEvents!.checkHealth();
          },
          workerEventIngestor: eventStore,
          workerEventIngestToken: config.workerEventIngestToken!,
          terminalTurnProjectionSource: new LiveTerminalTurnProjectionSource({
            database,
            liveEvents: liveEvents!,
          }),
          liveTurnSnapshotSource: new ValkeyLiveTurnSnapshotSource({
            database,
            liveEvents: liveEvents!,
          }),
        }),
  });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    // Stop accepting new Worker batches before draining the projector and
    // closing the producer used as their durable acknowledgement boundary.
    await gateway.close();
    await projector?.close();
    await kafkaLog?.close();
    await liveEvents?.close();
    await database.destroy();
    await observability.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  try {
    if (config.autoRepairLiveEvents && config.kafka !== undefined && liveEvents !== undefined) {
      // Advisory locks are session-scoped, so this deliberately uses the
      // direct notification endpoint rather than transaction-pool PgBouncer.
      const repairDatabase = createDatabase({
        connectionString: config.databaseNotificationUrl,
        maxConnections: 1,
      });
      try {
        const report = await repairLiveEventsIfNeeded({
          database: repairDatabase,
          liveEvents,
          kafka: {
            ...config.kafka,
            clientId: `${config.kafka.clientId}-startup-repair`,
          },
        });
        operationalLog({
          service: "pi-cloud-event-gateway",
          level: "info",
          event: "live_event_repair_complete",
          attributes: report,
        });
      } finally {
        await repairDatabase.destroy();
      }
    }
    await projector?.start();
    await gateway.listen(config.port, config.host);
    process.stdout.write(
      `PiCloud Event Gateway listening on ${config.host}:${String(config.port)}\n`,
    );
  } catch (error: unknown) {
    await close().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startEventGateway().catch((error: unknown) => {
    const failure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "UnknownError", message: "Unknown Event Gateway startup failure" };
    process.stderr.write(`PiCloud Event Gateway failed to start ${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  });
}
