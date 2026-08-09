import { createDatabase } from "@agent-dock/database";
import { PostgresTenantApiAuthenticator } from "@agent-dock/control-plane/tenant-identity";
import { WebAuthenticationService } from "@agent-dock/control-plane/web-authentication";
import { startServiceObservability } from "@agent-dock/observability";
import { DurableEventStore } from "@agent-dock/runtime-core/durable-event-store";
import { PostgresSessionEventNotifications } from "@agent-dock/runtime-core/postgres-session-event-notifications";
import {
  KafkaWorkerEventLog,
  KafkaWorkerEventProjector,
  PostgresWorkerEventOutboxPublisher,
} from "@agent-dock/runtime-core/worker-event-log";
import { pathToFileURL } from "node:url";
import { EventGateway } from "./event-gateway.ts";
import { loadEventGatewayProductionConfig } from "./production-config.ts";

export async function startEventGateway(): Promise<void> {
  const config = await loadEventGatewayProductionConfig();
  const observability = await startServiceObservability({
    serviceName: "agent-dock-event-gateway",
    defaultMetricsPort: 9467,
  });
  const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 20 });
  const notifications = new PostgresSessionEventNotifications({
    connectionString: config.databaseNotificationUrl,
    applicationName: "agent-dock-event-gateway",
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
    },
  } as const;
  const eventStore = new DurableEventStore({
    database,
    eventNotificationPublisher: notifications,
  });
  const kafkaLog =
    config.kafka === undefined
      ? undefined
      : new KafkaWorkerEventLog({
          brokers: config.kafka.brokers,
          clientId: `${config.kafka.clientId}-producer`,
          topic: config.kafka.topic,
          ...(config.kafka.security === undefined ? {} : { security: config.kafka.security }),
        });
  const outboxPublisher =
    kafkaLog === undefined
      ? undefined
      : new PostgresWorkerEventOutboxPublisher({ database, eventLog: kafkaLog });
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
    ...(projector === undefined || outboxPublisher === undefined
      ? {}
      : {
          dependencyReadiness: async () => {
            projector.checkHealth();
            await outboxPublisher.checkHealth();
          },
        }),
  });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await outboxPublisher?.close();
    await projector?.close();
    await gateway.close();
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
  await projector?.start();
  await outboxPublisher?.start();
  await gateway.listen(config.port, config.host);
  process.stdout.write(
    `AgentDock Event Gateway listening on ${config.host}:${String(config.port)}\n`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startEventGateway().catch(() => {
    process.stderr.write("AgentDock Event Gateway failed to start\n");
    process.exitCode = 1;
  });
}
