import { readFile } from "node:fs/promises";

export type EventGatewayProductionConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  databaseNotificationUrl: string;
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
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: port(process.env.PORT),
    databaseUrl,
    databaseNotificationUrl,
  };
}
