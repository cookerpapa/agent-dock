import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { AgentDockApi, AgentDockApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.AGENT_DOCK_LIVE_MULTI_TENANT_LOAD !== "1") {
  throw new Error(
    "Set AGENT_DOCK_LIVE_MULTI_TENANT_LOAD=1 to acknowledge real multi-tenant model usage",
  );
}

const tenantCount = Number(process.env.AGENT_DOCK_LIVE_MULTI_TENANT_COUNT ?? "6");
if (!Number.isSafeInteger(tenantCount) || tenantCount < 2 || tenantCount > 12) {
  throw new Error("AGENT_DOCK_LIVE_MULTI_TENANT_COUNT must be an integer from 2 to 12");
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);

async function readPrivate(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new Error(`${label} is not a private bounded file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const environment = Object.fromEntries(
  (await readPrivate(resolve(runtimeDirectory, ".env"), 64 * 1_024, "Production environment"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.AGENT_DOCK_HTTP_BIND_ADDRESS;
const port = environment.AGENT_DOCK_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);

function capture(command, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 2 * 1_024 * 1_024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`${command} failed: ${stderr.trim().slice(-2_000) || error.message}`, {
              cause: error,
            }),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function psql(query) {
  return capture(process.execPath, [
    "scripts/production-compose.mjs",
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username",
    "agent_dock",
    "--dbname",
    "agent_dock",
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

async function readRunUsage(runId) {
  const row = await psql(
    `select count(*)::text || '|' ||
            coalesce(sum(input_tokens), 0)::text || '|' ||
            coalesce(sum(output_tokens), 0)::text || '|' ||
            coalesce(sum(cache_read_tokens), 0)::text || '|' ||
            coalesce(sum(cache_write_tokens), 0)::text
       from usage_ledger
      where run_id = ${sqlLiteral(runId)}`,
  );
  const [requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = row
    .trim()
    .split("|")
    .map((value) => Number(value));
  for (const value of [requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]) {
    assert(Number.isSafeInteger(value) && value >= 0, "Run usage evidence is invalid");
  }
  return { requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

async function readStreamEvidence(runIds) {
  assert(runIds.length > 0, "Stream evidence requires at least one Run");
  const row = await psql(
    `select count(*)::text || '|' ||
            count(*) filter (where e.type = 'assistant.text.delta')::text || '|' ||
            coalesce(sum(octet_length(e.payload::text)), 0)::text
       from session_events e
       join runs r on r.turn_id = e.turn_id
      where r.id in (${runIds.map(sqlLiteral).join(", ")})`,
  );
  const [persistedEvents, assistantTextEvents, persistedPayloadBytes] = row
    .trim()
    .split("|")
    .map((value) => Number(value));
  for (const value of [persistedEvents, assistantTextEvents, persistedPayloadBytes]) {
    assert(Number.isSafeInteger(value) && value >= 0, "Stream evidence is invalid");
  }
  return {
    persistedEvents,
    assistantTextEvents,
    persistedPayloadBytes,
    eventsPerRun: Number((persistedEvents / runIds.length).toFixed(2)),
  };
}

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolvePromise();
    }
    signal?.addEventListener("abort", settle, { once: true });
  });
}

async function registerTenant(index, suffix) {
  const tenantSlug = `model-load-${suffix}-${String(index + 1)}`;
  const response = await fetch(new URL("/v1/registrations", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantSlug,
      displayName: `Model Load Tenant ${String(index + 1)}`,
    }),
  });
  const body = await response.json();
  if (
    response.status !== 201 ||
    typeof body.apiToken !== "string" ||
    typeof body.tenantId !== "string"
  ) {
    throw new Error(`Tenant registration returned HTTP ${String(response.status)}`);
  }
  const api = new AgentDockApi(fetchFromProduction, body.apiToken);
  const model = await api.getModelConfiguration();
  assert.equal(model.mode, "real", `${tenantSlug} did not inherit the platform real model`);
  const project = await api.createProject(`Multi-tenant model load ${suffix}`);
  const session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Multi-tenant model load ${suffix}`,
  );
  return {
    tenantSlug,
    tenantId: body.tenantId,
    token: body.apiToken,
    api,
    model,
    session,
    marker: `TENANT-${String(index + 1)}-${suffix.toUpperCase()}`,
    cursor: 0,
  };
}

async function waitForRun(api, runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(
        `Run ${run.runId} ended as ${run.state}${
          run.failure === undefined
            ? ""
            : ` (${run.failure.code}: ${run.failure.message ?? "no detail"})`
        }`,
      );
    }
    await wait(100);
  }
  throw new Error(`Run ${runId} did not settle`);
}

async function runTurn(lane, prompt, round) {
  const submittedAt = performance.now();
  const accepted = await lane.api.acceptTurn(
    lane.session.sessionId,
    prompt,
    newIdempotencyKey(`tenant-${String(round)}`),
    "off",
  );
  const acceptedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Multi-tenant live turn timed out")),
    10 * 60_000,
  );
  const text = [];
  let firstTextMs;
  let terminal;
  let toolEvents = 0;
  try {
    const cursor = await streamSessionEvents({
      sessionId: lane.session.sessionId,
      afterSequence: lane.cursor,
      signal: controller.signal,
      authorizationToken: lane.token,
      fetchImplementation: fetchFromProduction,
      retryDelayMs: 100,
      onStatus() {},
      onEvent(event) {
        if (event.turnId !== accepted.turnId) return;
        if (event.type === "assistant.text.delta") {
          if (firstTextMs === undefined) {
            firstTextMs = Math.round(performance.now() - submittedAt);
          }
          text.push(event.payload.text);
        }
        if (event.type.startsWith("tool.")) toolEvents += 1;
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled"
        ) {
          terminal = event;
          controller.abort();
        }
      },
    });
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    const run = await waitForRun(lane.api, accepted.runId);
    const usage = await readRunUsage(accepted.runId);
    assert(usage.requests > 0);
    assert(usage.inputTokens > 0);
    assert(usage.outputTokens > 0);
    assert.equal(toolEvents, 0, "Pure-chat load unexpectedly invoked a Tool");
    lane.cursor = cursor;
    return {
      tenantId: lane.tenantId,
      tenantSlug: lane.tenantSlug,
      runId: accepted.runId,
      turnId: accepted.turnId,
      round,
      text: text.join(""),
      acceptedMs: Math.round(acceptedAt - submittedAt),
      firstTextMs,
      settledMs: Math.round(performance.now() - submittedAt),
      usage,
      attemptCount: run.attempts.length,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function runEvidence(runId) {
  const row = await psql(
    `select s.supervisor_id || '|' ||
            round(extract(epoch from (r.started_at - r.queued_at)) * 1000)::text || '|' ||
            a.attempt_number::text || '|' ||
            a.state
       from runs r
       join run_attempts a on a.id = r.current_attempt_id
       join sandboxes s on s.id = a.sandbox_id
      where r.id = ${sqlLiteral(runId)}`,
  );
  const [supervisorId, queueWaitMs, attemptNumber, attemptState] = row.split("|");
  assert(supervisorId, `Run ${runId} has no Worker assignment`);
  assert.equal(attemptState, "completed");
  return {
    supervisorId,
    queueWaitMs: Number(queueWaitMs),
    attemptNumber: Number(attemptNumber),
  };
}

function percentile(values, ratio) {
  assert(values.length > 0);
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

function distribution(values) {
  return {
    minimum: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
  };
}

function sumUsage(results) {
  return results.reduce(
    (total, result) => ({
      requests: total.requests + result.usage.requests,
      inputTokens: total.inputTokens + result.usage.inputTokens,
      outputTokens: total.outputTokens + result.usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + result.usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + result.usage.cacheWriteTokens,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const lanes = await Promise.all(
  Array.from({ length: tenantCount }, (_, index) => registerTenant(index, suffix)),
);

for (let index = 0; index < lanes.length; index += 1) {
  const current = lanes[index];
  const foreign = lanes[(index + 1) % lanes.length];
  await assert.rejects(
    current.api.getConversation(foreign.session.sessionId),
    (error) => error instanceof AgentDockApiError && error.status === 404,
  );
}

const firstRound = await Promise.all(
  lanes.map((lane) =>
    runTurn(
      lane,
      `Remember this exact marker for the next turn: ${lane.marker}. Do not call tools. Reply with ACK and the exact marker only.`,
      1,
    ),
  ),
);
for (const [index, result] of firstRound.entries()) {
  assert(result.text.includes(lanes[index].marker), `${result.tenantSlug} omitted its own marker`);
}

const secondRound = await Promise.all(
  lanes.map((lane) =>
    runTurn(
      lane,
      [
        "Do not call tools.",
        `Begin with the exact marker I asked you to remember in the prior turn.`,
        "Then write eight concise numbered Chinese sentences explaining why a durable Worker pool can move a Session between Workers.",
      ].join(" "),
      2,
    ),
  ),
);
for (const [index, result] of secondRound.entries()) {
  assert(
    result.text.includes(lanes[index].marker),
    `${result.tenantSlug} restored the wrong marker`,
  );
  for (const foreign of lanes) {
    if (foreign === lanes[index]) continue;
    assert(
      !result.text.includes(foreign.marker),
      `${result.tenantSlug} leaked another tenant's marker`,
    );
  }
}

const allResults = [...firstRound, ...secondRound];
const evidence = await Promise.all(allResults.map(({ runId }) => runEvidence(runId)));
const totalUsage = sumUsage(allResults);
const streaming = await readStreamEvidence(allResults.map(({ runId }) => runId));
const report = {
  accepted: true,
  checkedAt: new Date().toISOString(),
  tenants: tenantCount,
  runs: allResults.length,
  model: {
    provider: lanes[0].model.provider,
    modelId: lanes[0].model.modelId,
  },
  correctness: {
    completedRuns: allResults.length,
    failedRuns: 0,
    markerRestores: secondRound.length,
    crossTenantApiDenials: lanes.length,
    crossTenantMarkerLeaks: 0,
    unexpectedToolEvents: 0,
    maximumAttemptCount: Math.max(...allResults.map((result) => result.attemptCount)),
  },
  latencyMs: {
    acceptance: distribution(allResults.map((result) => result.acceptedMs)),
    firstText: distribution(
      allResults.map((result) => {
        assert.notEqual(result.firstTextMs, undefined);
        return result.firstTextMs;
      }),
    ),
    settled: distribution(allResults.map((result) => result.settledMs)),
    queueWait: distribution(evidence.map((item) => item.queueWaitMs)),
  },
  workers: {
    distinct: [...new Set(evidence.map((item) => item.supervisorId))],
    assignments: Object.fromEntries(
      [...new Set(evidence.map((item) => item.supervisorId))].map((worker) => [
        worker,
        evidence.filter((item) => item.supervisorId === worker).length,
      ]),
    ),
  },
  streaming,
  usage: totalUsage,
};

assert.equal(report.correctness.maximumAttemptCount, 1);
assert.equal(report.workers.distinct.length, 2);
assert(totalUsage.requests >= allResults.length);
assert(totalUsage.inputTokens > 0 && totalUsage.outputTokens > 0);

const reportDirectory = resolve(repositoryRoot, "docs/reports");
await mkdir(reportDirectory, { recursive: true });
await writeFile(
  resolve(reportDirectory, "multi-tenant-model-load-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await writeFile(
  resolve(reportDirectory, "multi-tenant-model-load-latest.md"),
  [
    "# Multi-tenant real-model load acceptance",
    "",
    `- Checked at: ${report.checkedAt}`,
    `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
    `- Tenants / Runs: ${String(report.tenants)} / ${String(report.runs)}`,
    `- Completed / failed: ${String(report.correctness.completedRuns)} / ${String(report.correctness.failedRuns)}`,
    `- Marker restores / cross-tenant leaks: ${String(report.correctness.markerRestores)} / ${String(report.correctness.crossTenantMarkerLeaks)}`,
    `- Worker assignments: ${Object.entries(report.workers.assignments)
      .map(([worker, count]) => `${worker}=${String(count)}`)
      .join(", ")}`,
    `- Acceptance p50/p95: ${String(report.latencyMs.acceptance.p50)} / ${String(report.latencyMs.acceptance.p95)} ms`,
    `- First text p50/p95: ${String(report.latencyMs.firstText.p50)} / ${String(report.latencyMs.firstText.p95)} ms`,
    `- Settled p50/p95: ${String(report.latencyMs.settled.p50)} / ${String(report.latencyMs.settled.p95)} ms`,
    `- Queue wait p50/p95: ${String(report.latencyMs.queueWait.p50)} / ${String(report.latencyMs.queueWait.p95)} ms`,
    `- Persisted events / assistant text events / events per Run: ${String(report.streaming.persistedEvents)} / ${String(report.streaming.assistantTextEvents)} / ${String(report.streaming.eventsPerRun)}`,
    `- Persisted event payload bytes: ${String(report.streaming.persistedPayloadBytes)}`,
    `- Real requests/input/output/cache-read tokens: ${String(report.usage.requests)} / ${String(report.usage.inputTokens)} / ${String(report.usage.outputTokens)} / ${String(report.usage.cacheReadTokens)}`,
    "",
    "Every tenant used an independent API credential, Project, Workspace, Session and Pi checkpoint. All first and follow-up Runs were submitted concurrently through the same Temporal Task Queue and two capacity-one Pi Workers. The follow-up restored only its own marker, foreign Session reads returned 404, no Tool Sandbox was activated, and every Run completed with one Attempt.",
    "",
  ].join("\n"),
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
