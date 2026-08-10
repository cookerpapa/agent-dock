import { createDatabase } from "@agent-dock/database";
import { operationalLog, startServiceObservability } from "@agent-dock/observability";
import { createS3CheckpointObjectStoreFromEnvironment } from "@agent-dock/runtime-core/s3-checkpoint-object-store";
import {
  DEFAULT_SESSION_EVENT_HOT_RETENTION_MS,
  SessionEventRetentionService,
} from "@agent-dock/runtime-core/session-event-retention";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_SECRET_BYTES = 16 * 1_024;
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
    throw new TypeError(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return parsed;
}

async function readPrivateFile(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("DATABASE_URL_FILE must be an absolute path");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_BYTES
    ) {
      throw new TypeError("DATABASE_URL_FILE is not a private bounded regular file");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (value.length < 1 || value.length > MAX_SECRET_BYTES || /[\r\n\0]/.test(value)) {
      throw new TypeError("DATABASE_URL_FILE contains an invalid database URL");
    }
    return value;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(settle, delayMs);
    timer.unref();
    const onAbort = (): void => settle();
    function settle(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function startEventRetentionWorker(): Promise<void> {
  const databaseUrlFile = process.env.DATABASE_URL_FILE ?? "/run/agent-dock-secrets/database-url";
  const database = createDatabase({
    connectionString: await readPrivateFile(databaseUrlFile),
    maxConnections: 4,
  });
  const objectStore = createS3CheckpointObjectStoreFromEnvironment();
  const observability = await startServiceObservability({
    serviceName: "agent-dock-event-retention",
    defaultMetricsPort: 9468,
  });
  const controller = new AbortController();
  const hotRetentionDays = integerEnvironment(
    "AGENT_DOCK_EVENT_HOT_RETENTION_DAYS",
    DEFAULT_SESSION_EVENT_HOT_RETENTION_MS / (24 * 60 * 60 * 1_000),
    1,
    3_650,
  );
  const idleIntervalMs = integerEnvironment(
    "AGENT_DOCK_EVENT_RETENTION_INTERVAL_MS",
    DEFAULT_IDLE_INTERVAL_MS,
    1_000,
    24 * 60 * 60 * 1_000,
  );
  const errorRetryMs = integerEnvironment(
    "AGENT_DOCK_EVENT_RETENTION_ERROR_RETRY_MS",
    DEFAULT_ERROR_RETRY_MS,
    1_000,
    60 * 60 * 1_000,
  );
  const batchSize = integerEnvironment(
    "AGENT_DOCK_EVENT_RETENTION_BATCH_SIZE",
    DEFAULT_BATCH_SIZE,
    1,
    10_000,
  );
  const service = new SessionEventRetentionService({
    database,
    objectStore,
    hotRetentionMs: hotRetentionDays * 24 * 60 * 60 * 1_000,
  });
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await objectStore.checkHealth();
    while (!controller.signal.aborted) {
      let archived = 0;
      try {
        while (archived < batchSize && !controller.signal.aborted) {
          const result = await service.runOnce();
          if (result.status === "idle") break;
          archived += 1;
          operationalLog({
            service: "agent-dock-event-retention",
            level: "info",
            event: "event-retention.archived",
            attributes: {
              firstSequence: result.firstSequence,
              lastSequence: result.lastSequence,
              eventCount: result.eventCount,
              compressedBytes: result.compressedBytes,
              uncompressedBytes: result.uncompressedBytes,
            },
          });
        }
        await wait(archived === batchSize ? 1_000 : idleIntervalMs, controller.signal);
      } catch (error: unknown) {
        operationalLog({
          service: "agent-dock-event-retention",
          level: "error",
          event: "event-retention.failed",
          attributes: {
            code:
              typeof error === "object" && error !== null && "code" in error
                ? String((error as { code?: unknown }).code)
                : "event_retention_failed",
          },
        });
        await wait(errorRetryMs, controller.signal);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    objectStore.destroy();
    await database.destroy();
    await observability.close();
  }
}

startEventRetentionWorker().catch(() => {
  process.stderr.write("AgentDock Session event retention worker failed to start\n");
  process.exitCode = 1;
});
