import { createDatabase } from "@pi-cloud/database";
import { operationalLog, startServiceObservability } from "@pi-cloud/observability";
import { SessionLiveStreamCompactionService } from "@pi-cloud/runtime-core/session-event-retention";
import { readFile } from "node:fs/promises";

const DEFAULT_IDLE_INTERVAL_MS = 60_000;
const DEFAULT_ERROR_RETRY_MS = 5_000;
const DEFAULT_BATCH_SIZE = 100;

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

async function secret(path: string, name: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 1 || value.includes("\0")) throw new TypeError(`${name} is invalid`);
  return value;
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function startEventRetentionWorker(): Promise<void> {
  const databaseUrl = await secret(
    process.env.DATABASE_URL_FILE ?? "/run/pi-cloud-secrets/database-url",
    "Database URL",
  );
  const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
  const observability = await startServiceObservability({
    serviceName: "pi-cloud-live-stream-compactor",
    defaultMetricsPort: 9468,
  });
  const controller = new AbortController();
  const idleIntervalMs = integerEnvironment(
    "PI_CLOUD_EVENT_RETENTION_INTERVAL_MS",
    DEFAULT_IDLE_INTERVAL_MS,
    1_000,
    24 * 60 * 60 * 1_000,
  );
  const errorRetryMs = integerEnvironment(
    "PI_CLOUD_EVENT_RETENTION_ERROR_RETRY_MS",
    DEFAULT_ERROR_RETRY_MS,
    1_000,
    60 * 60 * 1_000,
  );
  const batchSize = integerEnvironment(
    "PI_CLOUD_EVENT_RETENTION_BATCH_SIZE",
    DEFAULT_BATCH_SIZE,
    1,
    10_000,
  );
  const service = new SessionLiveStreamCompactionService({ database });
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!controller.signal.aborted) {
      let compacted = 0;
      try {
        while (compacted < batchSize && !controller.signal.aborted) {
          const result = await service.runOnce();
          if (result.status === "idle") break;
          compacted += 1;
          operationalLog({
            service: "pi-cloud-live-stream-compactor",
            level: "info",
            event: "live-stream.compacted",
            attributes: { throughSequence: result.throughSequence },
          });
        }
        await wait(compacted === batchSize ? 1_000 : idleIntervalMs, controller.signal);
      } catch (error: unknown) {
        operationalLog({
          service: "pi-cloud-live-stream-compactor",
          level: "error",
          event: "live-stream.compaction-failed",
          attributes: { code: error instanceof Error ? error.name : "unknown" },
        });
        await wait(errorRetryMs, controller.signal);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await database.destroy();
    await observability.close();
  }
}

startEventRetentionWorker().catch(() => {
  process.stderr.write("PiCloud live stream compactor failed to start\n");
  process.exitCode = 1;
});
