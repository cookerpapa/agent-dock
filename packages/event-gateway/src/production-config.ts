import { readFile } from "node:fs/promises";

export type EventGatewayProductionConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  databaseNotificationUrl: string;
  workerEventIngestToken?: string;
  liveEventStoreUrl?: string;
  kafka?: {
    brokers: readonly string[];
    clientId: string;
    topic: string;
    groupId: string;
    security?: {
      ca: string;
      username: string;
      password: string;
    };
  };
};

async function readSecret(path: string, name: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0 || value.includes("\0")) throw new Error(`${name} is invalid`);
  return value;
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "4600");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT is invalid");
  }
  return parsed;
}

export async function loadEventGatewayProductionConfig(): Promise<EventGatewayProductionConfig> {
  const databaseUrlPath = process.env.DATABASE_URL_FILE ?? "/run/agent-dock-secrets/database-url";
  const notificationUrlPath =
    process.env.AGENT_DOCK_DATABASE_NOTIFICATION_URL_FILE ?? databaseUrlPath;
  const [databaseUrl, databaseNotificationUrl] = await Promise.all([
    readSecret(databaseUrlPath, "database URL"),
    readSecret(notificationUrlPath, "database notification URL"),
  ]);
  const kafkaBrokers = (process.env.AGENT_DOCK_KAFKA_BROKERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const kafkaSecurityPaths = [
    process.env.AGENT_DOCK_KAFKA_CA_FILE,
    process.env.AGENT_DOCK_KAFKA_USERNAME_FILE,
    process.env.AGENT_DOCK_KAFKA_PASSWORD_FILE,
  ];
  const configuredKafkaSecurityPaths = kafkaSecurityPaths.filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  if (
    configuredKafkaSecurityPaths.length !== 0 &&
    configuredKafkaSecurityPaths.length !== kafkaSecurityPaths.length
  ) {
    throw new Error("Kafka TLS/SASL secret files must be configured together");
  }
  const kafkaSecurity =
    configuredKafkaSecurityPaths.length === 0
      ? undefined
      : {
          ca: await readSecret(configuredKafkaSecurityPaths[0]!, "Kafka CA"),
          username: await readSecret(configuredKafkaSecurityPaths[1]!, "Kafka username"),
          password: await readSecret(configuredKafkaSecurityPaths[2]!, "Kafka password"),
        };
  const kafka =
    kafkaBrokers.length === 0
      ? undefined
      : {
          brokers: kafkaBrokers,
          clientId: process.env.AGENT_DOCK_KAFKA_CLIENT_ID ?? "agent-dock-event-gateway",
          topic: process.env.AGENT_DOCK_WORKER_EVENT_TOPIC ?? "agent-dock-worker-events-v1",
          groupId:
            process.env.AGENT_DOCK_WORKER_EVENT_PROJECTOR_GROUP ??
            "agent-dock-worker-event-projector-v1",
          ...(kafkaSecurity === undefined ? {} : { security: kafkaSecurity }),
        };
  const workerEventIngestToken =
    kafka === undefined
      ? undefined
      : await readSecret(
          process.env.AGENT_DOCK_WORKER_EVENT_INGEST_TOKEN_FILE ??
            "/run/agent-dock-secrets/worker-event-ingest-token",
          "Worker event ingest token",
        );
  const liveEventStoreUrl =
    kafka === undefined
      ? undefined
      : await readSecret(
          process.env.AGENT_DOCK_LIVE_EVENT_STORE_URL_FILE ??
            "/run/agent-dock-secrets/live-event-store-url",
          "Valkey live event store URL",
        );
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: port(process.env.PORT),
    databaseUrl,
    databaseNotificationUrl,
    ...(kafka === undefined ? {} : { kafka }),
    ...(workerEventIngestToken === undefined ? {} : { workerEventIngestToken }),
    ...(liveEventStoreUrl === undefined ? {} : { liveEventStoreUrl }),
  };
}
