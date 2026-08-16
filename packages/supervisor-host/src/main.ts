import { createDatabase } from "@pi-cloud/database";
import { PostgresCheckpointObjectStore } from "@pi-cloud/runtime-core/checkpoint-runtime";
import { startServiceObservability } from "@pi-cloud/observability";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadSupervisorHostConfig } from "./config.ts";
import { SupervisorHostRuntime } from "./runtime.ts";

type StopReason = "sigint" | "sigterm" | "owner_stopped" | "connection_failed";

function safeFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof TypeError) return "invalid_supervisor_configuration";
  return "supervisor_host_start_failed";
}

function signalPromise(): Promise<"sigint" | "sigterm"> {
  return new Promise((resolvePromise) => {
    process.once("SIGINT", () => resolvePromise("sigint"));
    process.once("SIGTERM", () => resolvePromise("sigterm"));
  });
}

export async function startSupervisorHost(): Promise<void> {
  const config = await loadSupervisorHostConfig();
  const observability = await startServiceObservability({
    serviceName: "pi-cloud-trusted-runner",
    defaultMetricsPort: 9465,
  });
  const database = createDatabase({
    connectionString: config.databaseUrl,
    maxConnections: Math.max(4, config.maxConcurrentSessions * 4),
  });
  const objectStore = new PostgresCheckpointObjectStore(database);
  const runtime = new SupervisorHostRuntime({
    config,
    database,
    objectStore,
    metrics: observability.metrics,
  });
  try {
    await runtime.start();
    const identity = runtime.identity!;
    process.stdout.write(
      `PiCloud Supervisor host ready supervisor=${identity.supervisorId} boot=${identity.bootId} sandbox=${identity.sandboxId}\n`,
    );
    const reason: StopReason = await Promise.race([runtime.waitUntilTerminal(), signalPromise()]);
    if (reason === "owner_stopped") {
      // Give Fastify a bounded window to flush the owner proof before this
      // process exits and the container runtime starts a fresh boot.
      await delay(250);
    }
    await runtime.close();
    await observability.close();
    await database.destroy();
    if (reason === "connection_failed") {
      process.stderr.write(
        `PiCloud Supervisor host failed code=${runtime.terminalFailureCode ?? "supervisor_connection_failed"}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    await runtime.close().catch(() => undefined);
    await observability.close().catch(() => undefined);
    await database.destroy().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startSupervisorHost().catch((error: unknown) => {
    process.stderr.write(`PiCloud Supervisor host failed code=${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
