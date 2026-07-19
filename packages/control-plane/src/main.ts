import { pathToFileURL } from "node:url";
import { createDatabase } from "@agent-dock/database";
import { parseUuidPathParameter } from "@agent-dock/protocol";
import { createControlPlaneApplication } from "./application.ts";
import { PostgresSessionEventNotifications } from "./postgres-session-event-notifications.ts";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is missing`);
  }
  return value;
}

function listenPort(): number {
  const value = process.env.PORT ?? "3000";
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export async function startControlPlane(): Promise<void> {
  const connectionString = requiredEnvironment("DATABASE_URL");
  const tenantId = parseUuidPathParameter(
    requiredEnvironment("AGENT_DOCK_TENANT_ID"),
    "AGENT_DOCK_TENANT_ID",
  );
  const database = createDatabase({
    connectionString,
    maxConnections: 10,
  });
  const sessionEventNotifications = new PostgresSessionEventNotifications({
    connectionString,
    tenantId,
  });
  let application: Awaited<ReturnType<typeof createControlPlaneApplication>> | undefined;
  try {
    const runningApplication = await createControlPlaneApplication({
      database,
      tenantId,
      defaultModelProfileId: parseUuidPathParameter(
        requiredEnvironment("AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID"),
        "AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID",
      ),
      sessionEventNotifications,
    });
    application = runningApplication;
    const host = process.env.HOST ?? "127.0.0.1";
    const port = listenPort();
    await runningApplication.listen(port, host);
    process.stdout.write(`AgentDock control plane listening on ${host}:${String(port)}\n`);

    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await runningApplication.close();
      await database.destroy();
    };
    const closeAfterSignal = () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", closeAfterSignal);
    process.once("SIGTERM", closeAfterSignal);
  } catch (error) {
    await application?.close().catch(() => undefined);
    await sessionEventNotifications.stop().catch(() => undefined);
    await database.destroy();
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startControlPlane().catch(() => {
    process.stderr.write("AgentDock control plane failed to start\n");
    process.exitCode = 1;
  });
}
