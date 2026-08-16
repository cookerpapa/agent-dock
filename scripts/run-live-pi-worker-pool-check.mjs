import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_WORKER_POOL_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_WORKER_POOL_CHECK=1 to acknowledge real model usage and a controlled Worker restart",
  );
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
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
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const token = (
  await readPrivate(resolve(runtimeDirectory, "secrets/api-token"), 4_096, "Production API token")
).trim();
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);
const api = new PiCloudApi(fetchFromProduction, token);
const workerDeployment = environment.PI_CLOUD_PI_WORKER_DEPLOYMENT ?? "compose";
if (workerDeployment !== "compose" && workerDeployment !== "kubernetes") {
  throw new Error("Production Pi Worker deployment mode is invalid");
}
const kubernetesKubeconfig = resolve(runtimeDirectory, "kubernetes/pi-worker-local.kubeconfig");
const kubernetesNamespace = "pi-cloud-workers";
const kubernetesStatefulSet = "pi-cloud-pi-worker-local-v1";
const kubernetesScaleDownWorker = `${kubernetesStatefulSet}-1`;

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
    "pi_cloud",
    "--dbname",
    "pi_cloud",
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

async function runUsageEvidence(runId) {
  const value = await psql(
    `select count(*) || '|' ||
            coalesce(sum(input_tokens), 0) || '|' ||
            coalesce(sum(output_tokens), 0) || '|' ||
            coalesce(sum(cache_read_tokens), 0) || '|' ||
            coalesce(sum(cache_write_tokens), 0)
       from usage_ledger
      where run_id = ${sqlLiteral(runId)}`,
  );
  const [requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = value
    .split("|")
    .map(Number);
  for (const number of [requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]) {
    assert(Number.isSafeInteger(number) && number >= 0, "Run usage evidence is invalid");
  }
  return { requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
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

async function waitForRun(runId) {
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

async function runTurn(sessionId, prompt, afterSequence = 0) {
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("pool"), "off");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Worker-pool live turn timed out")),
    10 * 60_000,
  );
  const text = [];
  let terminal;
  try {
    const cursor = await streamSessionEvents({
      sessionId,
      afterSequence,
      signal: controller.signal,
      authorizationToken: token,
      fetchImplementation: fetchFromProduction,
      retryDelayMs: 100,
      onStatus() {},
      onEvent(event) {
        if (event.turnId !== accepted.turnId) return;
        if (event.type === "assistant.text.delta") text.push(event.payload.text);
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
    await waitForRun(accepted.runId);
    const usage = await runUsageEvidence(accepted.runId);
    assert(usage.requests > 0);
    assert(usage.inputTokens > 0);
    assert(usage.outputTokens > 0);
    return {
      ...accepted,
      cursor,
      text: text.join(""),
      usage,
      settledMs: Math.round(performance.now() - submittedAt),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function runEvidence(runId) {
  const row = await psql(
    `select s.supervisor_id || '|' ||
            coalesce(r.workspace_base_version_id::text, '') || '|' ||
            coalesce(a.checkpoint_revision, '')
       from runs r
       join run_attempts a on a.id = r.current_attempt_id
       join sandboxes s on s.id = a.sandbox_id
      where r.id = ${sqlLiteral(runId)}`,
  );
  const [supervisorId, baseWorkspaceVersionId, checkpointRevision] = row.split("|");
  assert(supervisorId, `Run ${runId} has no Supervisor assignment`);
  return { supervisorId, baseWorkspaceVersionId, checkpointRevision };
}

async function activeWorkers() {
  const output = await psql(
    `select distinct supervisor_id || '|' || boot_id::text || '|' || accepting_assignments::text
       from supervisor_connections
      where state = 'active'
        and expires_at > now()
      order by 1`,
  );
  const connected =
    output.length === 0
      ? []
      : output.split("\n").map((row) => {
          const [supervisorId, bootId, acceptingAssignments] = row.split("|");
          assert.equal(
            acceptingAssignments,
            "false",
            `${supervisorId} still exposes the superseded WebSocket matcher`,
          );
          return { supervisorId, workerIdentity: `${supervisorId}/${bootId}` };
        });
  return connected.map(({ supervisorId }) => supervisorId);
}

async function waitForWorkers(expectedCount) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const workers = await activeWorkers();
    if (workers.length === expectedCount) return workers;
    await wait(250);
  }
  throw new Error(`Worker pool did not converge to ${String(expectedCount)} active Workers`);
}

function composeService(supervisorId) {
  if (supervisorId.endsWith("-1")) return "supervisor-host";
  if (supervisorId.endsWith("-2")) return "supervisor-host-1";
  throw new Error(`No production Compose service mapping for ${supervisorId}`);
}

async function stopWorker(supervisorId) {
  if (workerDeployment === "compose") {
    const service = composeService(supervisorId);
    await capture(process.execPath, ["scripts/production-compose.mjs", "stop", service]);
    return { mode: "compose", service };
  }
  assert.equal(
    supervisorId,
    kubernetesScaleDownWorker,
    "The selected Kubernetes failover owner must be StatefulSet ordinal 1",
  );
  await capture("kubectl", [
    "--kubeconfig",
    kubernetesKubeconfig,
    "--namespace",
    kubernetesNamespace,
    "scale",
    "statefulset",
    kubernetesStatefulSet,
    "--replicas=1",
  ]);
  return { mode: "kubernetes" };
}

async function restoreWorker(stoppedWorker) {
  if (stoppedWorker.mode === "compose") {
    await capture(process.execPath, [
      "scripts/production-compose.mjs",
      "start",
      stoppedWorker.service,
    ]);
  } else {
    await capture("kubectl", [
      "--kubeconfig",
      kubernetesKubeconfig,
      "--namespace",
      kubernetesNamespace,
      "scale",
      "statefulset",
      kubernetesStatefulSet,
      "--replicas=2",
    ]);
  }
  await waitForWorkers(2);
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

const initialWorkers = await waitForWorkers(2);
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
let stoppedWorker;

try {
  const candidates = [];
  const maximumCandidates = workerDeployment === "kubernetes" ? 8 : 1;
  let selected;
  for (let index = 0; index < maximumCandidates && selected === undefined; index += 1) {
    const marker = `PI-POOL-${suffix.toUpperCase()}-${String(index + 1)}`;
    const project = await api.createProject(`Pi Worker pool acceptance ${suffix}-${index + 1}`);
    const session = await api.createSession(
      project.projectId,
      project.workspaceId,
      `Pi Worker pool acceptance ${suffix}-${index + 1}`,
    );
    const turn = await runTurn(
      session.sessionId,
      `Remember this marker for my next message: ${marker}. Do not call tools. Reply exactly ACK.`,
    );
    const candidate = {
      marker,
      session,
      turn,
      evidence: await runEvidence(turn.runId),
    };
    candidates.push(candidate);
    if (
      workerDeployment === "compose" ||
      candidate.evidence.supervisorId === kubernetesScaleDownWorker
    ) {
      selected = candidate;
    }
  }
  assert(selected, "No first-turn candidate ran on the removable Kubernetes Worker");
  const { marker, session, turn: first, evidence: firstEvidence } = selected;
  stoppedWorker = await stopWorker(firstEvidence.supervisorId);
  const survivingWorkers = await waitForWorkers(1);
  assert(!survivingWorkers.includes(firstEvidence.supervisorId));

  const followUp = await runTurn(
    session.sessionId,
    "What exact marker did I ask you to remember in my previous message? Do not call tools. Reply with only that marker.",
    first.cursor,
  );
  const followUpEvidence = await runEvidence(followUp.runId);
  assert.notEqual(followUpEvidence.supervisorId, firstEvidence.supervisorId);
  assert(followUp.text.includes(marker), `Restored conversation omitted marker: ${followUp.text}`);
  await restoreWorker(stoppedWorker);
  stoppedWorker = undefined;

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, async (_, index) => {
      const concurrentProject = await api.createProject(`Pi pool lane ${index + 1} ${suffix}`);
      const concurrentSession = await api.createSession(
        concurrentProject.projectId,
        concurrentProject.workspaceId,
        `Pi pool lane ${index + 1} ${suffix}`,
      );
      const turn = await runTurn(
        concurrentSession.sessionId,
        [
          "Do not call any tool.",
          `Begin with POOL-LANE-${String(index + 1)}.`,
          "Then explain horizontal worker pools in twelve concise numbered lines.",
          "Use one complete sentence per line.",
        ].join(" "),
      );
      return { turn, evidence: await runEvidence(turn.runId) };
    }),
  );
  const concurrentWorkerIds = [...new Set(concurrent.map(({ evidence }) => evidence.supervisorId))];
  assert(
    concurrentWorkerIds.every((workerId) => initialWorkers.includes(workerId)),
    "A concurrent Run was assigned outside the active Worker pool",
  );
  const observedWorkerIds = [
    ...new Set([
      ...candidates.map(({ evidence }) => evidence.supervisorId),
      followUpEvidence.supervisorId,
      ...concurrentWorkerIds,
    ]),
  ].sort();
  assert.deepEqual(observedWorkerIds, [...initialWorkers].sort());

  const allTurns = [
    ...candidates.map(({ turn }) => turn),
    followUp,
    ...concurrent.map(({ turn }) => turn),
  ];
  const totalUsage = sumUsage(allTurns);
  const report = {
    accepted: true,
    checkedAt: new Date().toISOString(),
    model: { provider: model.provider, modelId: model.modelId },
    workerDeployment,
    workers: initialWorkers,
    failover: {
      firstWorker: firstEvidence.supervisorId,
      followUpWorker: followUpEvidence.supervisorId,
      differentWorker: firstEvidence.supervisorId !== followUpEvidence.supervisorId,
      postgresSessionRestored: followUp.text.includes(marker),
      markerRecovered: followUp.text.includes(marker),
      firstSettledMs: first.settledMs,
      followUpSettledMs: followUp.settledMs,
      candidateRuns: candidates.length,
    },
    concurrency: {
      runs: concurrent.length,
      workerIds: concurrent.map(({ evidence }) => evidence.supervisorId),
      distinctWorkers: concurrentWorkerIds.length,
      observedWorkerIds,
      settledMs: concurrent.map(({ turn }) => turn.settledMs),
    },
    totalUsage,
  };
  assert(totalUsage.requests >= 6 && totalUsage.inputTokens > 0 && totalUsage.outputTokens > 0);

  const reportDirectory = resolve(repositoryRoot, "docs/reports");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "pi-worker-pool-acceptance-latest.json"),
    await format(JSON.stringify(report), { parser: "json" }),
    "utf8",
  );
  await writeFile(
    resolve(reportDirectory, "pi-worker-pool-acceptance-latest.md"),
    [
      "# Pi Worker pool production acceptance",
      "",
      `- Checked at: ${report.checkedAt}`,
      `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
      `- Worker deployment: ${report.workerDeployment}`,
      `- Active Workers: ${report.workers.join(", ")}`,
      `- Cross-Worker restore: ${report.failover.firstWorker} -> ${report.failover.followUpWorker}`,
      `- PostgreSQL Pi Session restored: ${String(report.failover.postgresSessionRestored)}`,
      `- Previous-turn marker recovered: ${String(report.failover.markerRecovered)}`,
      `- Concurrent Runs / distinct Workers: ${String(report.concurrency.runs)} / ${String(report.concurrency.distinctWorkers)}`,
      `- Concurrent assignment: ${report.concurrency.workerIds.join(", ")}`,
      `- Real requests/input/output tokens: ${String(report.totalUsage.requests)} / ${String(report.totalUsage.inputTokens)} / ${String(report.totalUsage.outputTokens)}`,
      "",
      "The owning Pi Worker was stopped after the first real-model Turn. The surviving Worker rebuilt Pi's active model context directly from PostgreSQL SessionStorage, recovered the previous-turn marker and appended the follow-up incrementally. Further concurrent real-model Runs completed through the independently ready Worker pool; allocation is reported as evidence rather than assumed to be round-robin.",
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (stoppedWorker !== undefined) {
    await restoreWorker(stoppedWorker).catch(() => undefined);
  }
}
