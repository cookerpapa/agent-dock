import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  PersistentVolumeWorkspaceVolumeGateway,
  WorkspaceVolumeGatewayServer,
} from "./workspace-volume-gateway.ts";
import { createDatabase } from "@agent-dock/database";
import { startServiceObservability } from "@agent-dock/observability";
import { PostgresWorkspaceVolumeGatewayLock } from "./postgres-workspace-volume-gateway-lock.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length < 1) throw new TypeError(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

async function secret(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new TypeError("Secret path is invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 8_192) {
      throw new TypeError("Secret file is invalid");
    }
    return (await handle.readFile("utf8")).replace(/\r?\n$/, "");
  } finally {
    await handle.close();
  }
}

const database = createDatabase({
  connectionString: await secret(required("DATABASE_URL_FILE")),
  maxConnections: 4,
});
const observability = await startServiceObservability({
  serviceName: "agent-dock-workspace-volume-gateway",
  defaultMetricsPort: 9_469,
});
const gateway = new PersistentVolumeWorkspaceVolumeGateway({
  workspaceRoot: required("AGENT_DOCK_WORKSPACE_POSIX_ROOT"),
  lock: new PostgresWorkspaceVolumeGatewayLock(database),
});
const server = new WorkspaceVolumeGatewayServer({
  host: process.env.AGENT_DOCK_WORKSPACE_VOLUME_GATEWAY_HOST ?? "127.0.0.1",
  port: integer("AGENT_DOCK_WORKSPACE_VOLUME_GATEWAY_PORT", 4_500, 1, 65_535),
  serviceToken: await secret(required("AGENT_DOCK_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE")),
  gateway,
  maximumConcurrentOperations: integer(
    "AGENT_DOCK_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS",
    2,
    1,
    64,
  ),
  maximumQueuedOperations: integer(
    "AGENT_DOCK_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS",
    32,
    0,
    4_096,
  ),
  queueWaitTimeoutMs: integer(
    "AGENT_DOCK_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS",
    30_000,
    1,
    600_000,
  ),
  metrics: observability.metrics,
});
try {
  await server.listen();
} catch (error: unknown) {
  await Promise.allSettled([server.close(), observability.close(), database.destroy()]);
  throw error;
}
process.stdout.write("AgentDock Workspace Volume Gateway ready\n");

let closing: Promise<void> | undefined;
const closeService = (): Promise<void> =>
  (closing ??= server
    .close()
    .finally(() => Promise.allSettled([observability.close(), database.destroy()]))
    .then(() => undefined));
process.once("SIGTERM", () => void closeService());
process.once("SIGINT", () => void closeService());
