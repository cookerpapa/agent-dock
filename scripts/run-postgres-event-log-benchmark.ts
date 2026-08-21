import { createDatabase, runMigrations } from "@pi-cloud/database";
import type { EventPublishBatchMessage } from "@pi-cloud/protocol";
import { DurableEventStore } from "@pi-cloud/runtime-core/durable-event-store";
import { GroupedDurableEventIngestor } from "@pi-cloud/runtime-core/grouped-durable-event-ingestor";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";

const POSTGRES_IMAGE =
  "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);

function argument(name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function docker(arguments_: readonly string[], description: string): string {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1_024 * 1_024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${description} failed: ${(result.stderr || result.stdout).trim().slice(-2_000)}`,
    );
  }
  return result.stdout.trim();
}

function gitRevision(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Resolving Git revision failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastFailure = "not ready";
  while (Date.now() < deadline) {
    const database = createDatabase({ connectionString, maxConnections: 1 });
    try {
      await sql`select 1`.execute(database);
      await database.destroy();
      return;
    } catch (error: unknown) {
      lastFailure = error instanceof Error ? error.message : "unknown failure";
      await database.destroy().catch(() => undefined);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${lastFailure}`);
}

async function parallelMap<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<number>,
): Promise<{ durations: number[]; failures: string[] }> {
  const durations = new Array<number>(items.length);
  const failures: string[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          durations[index] = await operation(items[index]!, index);
        } catch (error: unknown) {
          durations[index] = 0;
          if (failures.length < 20) {
            failures.push(error instanceof Error ? error.message : "unknown event-ingest failure");
          }
        }
      }
    }),
  );
  return { durations, failures };
}

const sessions = integerArgument("--sessions", 2_000, 1, 20_000);
const batchesPerSession = integerArgument("--batches-per-session", 4, 1, 32);
const eventsPerBatch = integerArgument("--events-per-batch", 1, 1, 64);
const concurrency = integerArgument("--concurrency", 256, 1, 2_000);
const groupShards = integerArgument("--group-shards", 8, 1, 64);
const groupSize = integerArgument("--group-size", 64, 1, 200);
const maximumAckP95Ms = integerArgument("--maximum-ack-p95-ms", 500, 1, 60_000);
const minimumEventsPerSecond = integerArgument("--minimum-events-per-second", 1_000, 1, 10_000_000);
const outputJson = resolve(
  repositoryRoot,
  argument(
    "--output",
    sessions >= 10_000
      ? "docs/reports/postgres-event-log-10000-latest.json"
      : "docs/reports/postgres-event-log-2000-latest.json",
  ),
);
const outputMarkdown = outputJson.replace(/\.json$/u, ".md");
const containerName = `pi-cloud-event-benchmark-${randomUUID()}`;
const password = randomBytes(24).toString("base64url");
let containerStarted = false;

try {
  docker(
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      "POSTGRES_DB=pi_cloud_event_benchmark",
      POSTGRES_IMAGE,
    ],
    "Starting isolated PostgreSQL",
  );
  containerStarted = true;
  const published = docker(["port", containerName, "5432/tcp"], "Resolving PostgreSQL port");
  const port = Number(/:([0-9]+)$/u.exec(published)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1) throw new Error("Docker published port is invalid");
  const connectionString = `postgresql://postgres:${password}@127.0.0.1:${String(port)}/pi_cloud_event_benchmark`;
  await waitForPostgres(connectionString);
  const database = createDatabase({ connectionString, maxConnections: 64 });
  try {
    await runMigrations(database, "up");
    const tenantId = randomUUID();
    const userId = randomUUID();
    const credentialId = randomUUID();
    const profileId = randomUUID();
    await database
      .insertInto("tenants")
      .values({ id: tenantId, slug: "event-benchmark" })
      .execute();
    await database
      .insertInto("users")
      .values({ id: userId, tenant_id: tenantId, display_name: "Event Benchmark" })
      .execute();
    await database
      .insertInto("credential_bindings")
      .values({
        id: credentialId,
        tenant_id: tenantId,
        provider: "pi-cloud-fake",
        kind: "brokered",
        secret_ref: "broker://benchmark/fake",
        version: 1,
        status: "active",
      })
      .execute();
    await database
      .insertInto("model_profiles")
      .values({
        id: profileId,
        tenant_id: tenantId,
        name: "event-benchmark",
        provider: "pi-cloud-fake",
        model_id: "pi-cloud-fake",
        default_thinking_level: "off",
        allowed_thinking_levels: ["off"],
        credential_binding_id: credentialId,
        credential_binding_version: 1,
        enabled: true,
      })
      .execute();
    await database
      .insertInto("tenant_runtime_policies")
      .values({
        tenant_id: tenantId,
        default_model_profile_id: profileId,
        maximum_projects: 10,
        maximum_sessions: 20_000,
        maximum_unsettled_turns: 20_000,
        maximum_concurrent_turns: 256,
      })
      .execute();
    const store = new ControlPlaneStore({
      database,
      tenantId,
      defaultModelProfileId: profileId,
      environmentImageRevision: "event-benchmark",
    });
    const project = await store.createProject({
      name: "Event benchmark",
      source: { kind: "empty" },
    });
    const sessionRows = Array.from({ length: sessions }, (_, index) => ({
      id: randomUUID(),
      title: `Event stream ${String(index + 1)}`,
      tenant_id: tenantId,
      project_id: project.projectId,
      workspace_id: project.workspaceId,
      desired_model_profile_id: profileId,
      state: "running" as const,
      workspace_snapshot_key: null,
      last_fencing_token: 1,
    }));
    for (let offset = 0; offset < sessionRows.length; offset += 500) {
      const chunk = sessionRows.slice(offset, offset + 500);
      await database.insertInto("sessions").values(chunk).execute();
      await database
        .insertInto("session_event_cursors")
        .values(chunk.map((session) => ({ session_id: session.id })))
        .execute();
    }
    const turnIds = new Map(sessionRows.map((session) => [session.id, randomUUID()] as const));
    const turnRows = sessionRows.map((session) => ({
      id: turnIds.get(session.id)!,
      tenant_id: tenantId,
      session_id: session.id,
      state: "running" as const,
      input_kind: "prompt" as const,
      input_text: "event-log capacity benchmark",
      model_profile_id: profileId,
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
      thinking_level: "off" as const,
      credential_binding_id: credentialId,
      credential_binding_version: 1,
    }));
    for (let offset = 0; offset < turnRows.length; offset += 500) {
      await database
        .insertInto("turns")
        .values(turnRows.slice(offset, offset + 500))
        .execute();
    }
    const sandboxId = randomUUID();
    await database
      .insertInto("sandboxes")
      .values({
        id: sandboxId,
        supervisor_id: "event-benchmark",
        boot_id: randomUUID(),
        state: "leased",
        max_concurrent_sessions: sessions,
        active_sessions: sessions,
      })
      .execute();
    const leaseRows = sessionRows.map((session) => ({
      session_id: session.id,
      lease_id: randomUUID(),
      sandbox_id: sandboxId,
      fencing_token: 1,
      valid_until: new Date(Date.now() + 60 * 60 * 1_000),
    }));
    for (let offset = 0; offset < leaseRows.length; offset += 500) {
      await database
        .insertInto("session_leases")
        .values(leaseRows.slice(offset, offset + 500))
        .execute();
    }

    const before = await sql<{
      walBytes: string;
    }>`select wal_bytes::text as "walBytes" from pg_stat_wal`.execute(database);
    const eventStore = new DurableEventStore({ database });
    const eventIngestor = new GroupedDurableEventIngestor({
      store: eventStore,
      shardCount: groupShards,
      maximumGroupSize: groupSize,
      maximumDelayMs: 4,
    });
    const allDurations: number[] = [];
    const failures: string[] = [];
    const startedAt = performance.now();
    for (let batchIndex = 0; batchIndex < batchesPerSession; batchIndex += 1) {
      const wave = await parallelMap(leaseRows, concurrency, async (lease) => {
        const firstSequence = batchIndex * eventsPerBatch + 1;
        const occurredAt = new Date().toISOString();
        const message: EventPublishBatchMessage = {
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: occurredAt,
          type: "event.publish_batch",
          payload: {
            leaseId: lease.lease_id,
            fencingToken: 1,
            events: Array.from({ length: eventsPerBatch }, (_, eventIndex) => ({
              schemaVersion: 1,
              eventId: randomUUID(),
              sessionId: lease.session_id,
              turnId: turnIds.get(lease.session_id)!,
              agentId: "event-benchmark",
              seq: firstSequence + eventIndex,
              occurredAt,
              type: "assistant.text.delta" as const,
              payload: { text: `benchmark-${String(batchIndex)}-${String(eventIndex)}` },
            })),
          },
        };
        const operationStartedAt = performance.now();
        await eventIngestor.ingest(message);
        return performance.now() - operationStartedAt;
      });
      allDurations.push(...wave.durations);
      failures.push(...wave.failures);
      process.stdout.write(
        `${JSON.stringify({ wave: batchIndex + 1, batches: sessions, failures: wave.failures.length })}\n`,
      );
    }
    await eventIngestor.flush();
    const elapsedMs = performance.now() - startedAt;
    const after = await sql<{
      walBytes: string;
    }>`select wal_bytes::text as "walBytes" from pg_stat_wal`.execute(database);
    const persisted = await database
      .selectFrom("session_events")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const totalEvents = sessions * batchesPerSession * eventsPerBatch;
    const ackP95Ms = percentile(allDurations, 0.95);
    const eventsPerSecond = (totalEvents * 1_000) / elapsedMs;
    const walBytes =
      BigInt(after.rows[0]?.walBytes ?? "0") - BigInt(before.rows[0]?.walBytes ?? "0");
    const passed =
      failures.length === 0 &&
      Number(persisted.count) === totalEvents &&
      ackP95Ms <= maximumAckP95Ms &&
      eventsPerSecond >= minimumEventsPerSecond;
    const report = {
      format: "pi-cloud.postgres-event-log-capacity.v2",
      generatedAt: new Date().toISOString(),
      gitRevision: gitRevision(),
      database: { image: POSTGRES_IMAGE, partitions: 32, maxConnections: 64 },
      workload: {
        sessions,
        batchesPerSession,
        eventsPerBatch,
        concurrency,
        groupShards,
        groupSize,
        totalEvents,
      },
      result: {
        passed,
        failures: failures.slice(0, 20),
        persistedEvents: Number(persisted.count),
        elapsedMs: Math.round(elapsedMs),
        eventsPerSecond: Number(eventsPerSecond.toFixed(2)),
        batchTransactionsPerSecond: Number(
          ((sessions * batchesPerSession * 1_000) / elapsedMs).toFixed(2),
        ),
        ackLatencyMs: {
          p50: Number(percentile(allDurations, 0.5).toFixed(2)),
          p95: Number(ackP95Ms.toFixed(2)),
          p99: Number(percentile(allDurations, 0.99).toFixed(2)),
        },
        walBytes: Number(walBytes),
        walBytesPerEvent: Number((Number(walBytes) / totalEvents).toFixed(2)),
      },
      slo: { maximumAckP95Ms, minimumEventsPerSecond, zeroErrors: true },
      authorityDecision: passed
        ? "postgresql_remains_the_single_durable_event_authority"
        : "postgresql_profile_failed_slo_scale_or_revisit_log_architecture",
      limitations: [
        "isolated single-node PostgreSQL, not a managed HA cluster",
        "four synchronized coalesced events per Session, not provider token fragments",
        "event ingest only; model and Cube execution are intentionally excluded",
        "one transaction per Session batch preserves Session ordering",
      ],
    };
    const markdown =
      `# PostgreSQL durable event-log capacity\n\n` +
      `Generated: ${report.generatedAt}\n\n` +
      `This test writes ${totalEvents.toLocaleString("en-US")} durable events for ${sessions.toLocaleString("en-US")} active Sessions through the real PiCloud DurableEventStore.\n\n` +
      `- Result: ${passed ? "PASS" : "FAIL"}\n` +
      `- Throughput: ${report.result.eventsPerSecond.toLocaleString("en-US")} events/s\n` +
      `- Batch ACK p50/p95/p99: ${report.result.ackLatencyMs.p50} / ${report.result.ackLatencyMs.p95} / ${report.result.ackLatencyMs.p99} ms\n` +
      `- WAL: ${report.result.walBytes.toLocaleString("en-US")} bytes (${report.result.walBytesPerEvent} bytes/event)\n` +
      `- Decision: ${report.authorityDecision}\n`;
    await mkdir(dirname(outputJson), { recursive: true });
    await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(outputMarkdown, markdown, "utf8");
    process.stdout.write(`${JSON.stringify(report.result)}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    await database.destroy();
  }
} finally {
  if (containerStarted) {
    spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore" });
  }
}
