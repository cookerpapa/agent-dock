import { createDatabase, runMigrations } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";

const POSTGRES_IMAGE =
  "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const root = fileURLToPath(new URL("..", import.meta.url));
const sessionCount = Number(process.env.PI_CLOUD_PG_BENCHMARK_SESSIONS ?? "2000");
const mutationsPerSession = Number(process.env.PI_CLOUD_PG_BENCHMARK_MUTATIONS ?? "4");
const concurrency = Number(process.env.PI_CLOUD_PG_BENCHMARK_CONCURRENCY ?? "256");
for (const [value, name, maximum] of [
  [sessionCount, "sessions", 20_000],
  [mutationsPerSession, "mutations", 32],
  [concurrency, "concurrency", 2_000],
] as const) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
}

function docker(args: readonly string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function parallelMap<T>(
  items: readonly T[],
  maximumConcurrency: number,
  operation: (item: T) => Promise<number>,
): Promise<{ durations: number[]; failures: string[] }> {
  let cursor = 0;
  const durations = new Array<number>(items.length);
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(maximumConcurrency, items.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          durations[index] = await operation(items[index]!);
        } catch (error: unknown) {
          durations[index] = 0;
          if (failures.length < 20) failures.push(error instanceof Error ? error.message : "error");
        }
      }
    }),
  );
  return { durations, failures };
}

const container = `pi-cloud-session-projection-${randomUUID()}`;
const password = randomBytes(24).toString("base64url");
let started = false;
try {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=pi_cloud_session_projection",
    POSTGRES_IMAGE,
  ]);
  started = true;
  const port = Number(/:([0-9]+)$/u.exec(docker(["port", container, "5432/tcp"]))?.[1]);
  const connectionString = `postgresql://postgres:${password}@127.0.0.1:${String(port)}/pi_cloud_session_projection`;
  let database = createDatabase({ connectionString, maxConnections: 1 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sql`select 1`.execute(database);
      break;
    } catch {
      await database.destroy();
      if (attempt >= 100) throw new Error("PostgreSQL did not become ready");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      database = createDatabase({ connectionString, maxConnections: 1 });
    }
  }
  await database.destroy();
  database = createDatabase({ connectionString, maxConnections: 64 });
  try {
    await runMigrations(database, "up");
    const tenantId = randomUUID();
    await database
      .insertInto("tenants")
      .values({ id: tenantId, slug: "session-projection" })
      .execute();
    const sessions = Array.from({ length: sessionCount }, () => randomUUID());
    for (let offset = 0; offset < sessions.length; offset += 500) {
      const chunk = sessions.slice(offset, offset + 500);
      await database
        .insertInto("pi_sessions")
        .values(
          chunk.map((sessionId) => ({
            tenant_id: tenantId,
            id: sessionId,
            created_at_ms: Date.now(),
            parent_session_id: null,
            next_seq: 1,
            name: null,
          })),
        )
        .execute();
      await database
        .insertInto("pi_session_lanes")
        .values(
          chunk.map((sessionId) => ({
            tenant_id: tenantId,
            session_id: sessionId,
            lane: "main",
            leaf_id: null,
          })),
        )
        .execute();
    }
    const before = await sql<{
      bytes: string;
    }>`select wal_bytes::text as bytes from pg_stat_wal`.execute(database);
    const durations: number[] = [];
    const failures: string[] = [];
    const startedAt = performance.now();
    for (let wave = 0; wave < mutationsPerSession; wave += 1) {
      const result = await parallelMap(sessions, concurrency, async (sessionId) => {
        const mutationId = randomUUID();
        const operationStarted = performance.now();
        const storage = new PostgresPiSessionStorage({
          database,
          tenantId,
          sessionId,
          projectedMutationId: mutationId,
        });
        const entry = await storage.appendEntry(
          {
            id: randomUUID(),
            type: "custom",
            customType: "benchmark.complete_message",
            data: { wave, text: "x".repeat(1024) },
          },
          "main",
        );
        await database
          .insertInto("pi_session_mutation_results")
          .values({
            mutation_id: mutationId,
            tenant_id: tenantId,
            session_id: sessionId,
            run_id: randomUUID(),
            attempt_id: randomUUID(),
            state: "completed",
            result: entry as unknown as Record<string, unknown>,
            error_code: null,
            error_message: null,
            expires_at: new Date(Date.now() + 60 * 60_000),
          })
          .execute();
        return performance.now() - operationStarted;
      });
      durations.push(...result.durations);
      failures.push(...result.failures);
    }
    const elapsedMs = performance.now() - startedAt;
    const after = await sql<{
      bytes: string;
    }>`select wal_bytes::text as bytes from pg_stat_wal`.execute(database);
    const total = sessionCount * mutationsPerSession;
    const entries = await database
      .selectFrom("pi_session_entries")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const results = await database
      .selectFrom("pi_session_mutation_results")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const walBytes = Number(BigInt(after.rows[0]!.bytes) - BigInt(before.rows[0]!.bytes));
    const report = {
      format: "pi-cloud.postgres-session-projection-capacity.v1",
      generatedAt: new Date().toISOString(),
      revision: spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).stdout.trim(),
      workload: {
        sessionCount,
        mutationsPerSession,
        concurrency,
        completeMessages: total,
        payloadBytes: 1024,
      },
      result: {
        failures,
        persistedEntries: Number(entries.count),
        persistedResults: Number(results.count),
        elapsedMs: Number(elapsedMs.toFixed(2)),
        messagesPerSecond: Number(((total * 1000) / elapsedMs).toFixed(2)),
        latencyMs: {
          p50: Number(percentile(durations, 0.5).toFixed(2)),
          p95: Number(percentile(durations, 0.95).toFixed(2)),
          p99: Number(percentile(durations, 0.99).toFixed(2)),
        },
        walBytes,
        walBytesPerMessage: Number((walBytes / total).toFixed(2)),
      },
      scope: [
        "isolated single-node PostgreSQL",
        "complete 1 KiB Pi semantic entries plus projection-result barriers",
        "no token deltas, model calls or Cube execution",
      ],
    };
    await writeFile(
      `${root}/docs/reports/postgres-session-projection-latest.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      `${root}/docs/reports/postgres-session-projection-latest.md`,
      `# PostgreSQL Session projection acceptance\n\n- Complete messages: ${total}\n- Throughput: ${report.result.messagesPerSecond} messages/s\n- Latency p50/p95/p99: ${report.result.latencyMs.p50} / ${report.result.latencyMs.p95} / ${report.result.latencyMs.p99} ms\n- WAL: ${walBytes} bytes (${report.result.walBytesPerMessage} bytes/message)\n- Failures: ${failures.length}\n\nThis measures complete semantic Session projection, not token deltas.\n`,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failures.length > 0 || Number(entries.count) !== total || Number(results.count) !== total) {
      process.exitCode = 1;
    }
  } finally {
    await database.destroy();
  }
} finally {
  if (started) spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
}
