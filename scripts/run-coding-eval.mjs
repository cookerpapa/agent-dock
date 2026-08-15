import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const argumentsList = process.argv.slice(2);

function argument(name, fallback) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return fallback;
  const value = argumentsList[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

const baseUrl = new URL(argument("--base-url", "http://127.0.0.1:8080"));
if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
  throw new Error("Coding eval base URL must use HTTP or HTTPS");
}
const concurrency = Number(argument("--concurrency", "2"));
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  throw new Error("Coding eval concurrency must be between 1 and 32");
}
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const tokenFile = resolve(argument("--token-file", resolve(runtimeDirectory, "secrets/api-token")));
const outputJson = resolve(
  repositoryRoot,
  argument("--output", "docs/reports/coding-eval-latest.json"),
);
const outputMarkdown = outputJson.replace(/\.json$/, ".md");
const usePublicRegistration = argumentsList.includes("--register");
let registeredTenantSlug;
let token;
if (usePublicRegistration) {
  registeredTenantSlug = `coding-eval-${randomUUID().slice(0, 8)}`;
  const response = await fetch(new URL("/v1/registrations", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantSlug: registeredTenantSlug,
      displayName: "AgentDock Coding Evaluation",
    }),
  });
  const body = await response.json();
  if (response.status !== 201 || typeof body.apiToken !== "string") {
    throw new Error(`Public evaluation tenant registration returned ${String(response.status)}`);
  }
  token = body.apiToken;
} else {
  token = (await readFile(tokenFile, "utf8")).trim();
}
if (token.length < 32 || token.length > 512 || /[\x00-\x20\x7f]/.test(token)) {
  throw new Error("Coding eval API credential is invalid");
}
const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "eval/coding-tasks.json"), "utf8"),
);
assert.equal(manifest.format, "agent-dock.coding-eval.v1");
assert.equal(manifest.tasks.length, 10);

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== expectedStatus) {
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${String(response.status)}: ${bytes.toString("utf8").slice(0, 1_000)}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? JSON.parse(bytes.toString("utf8")) : bytes;
}

async function waitForRun(runId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const run = await request(`/v1/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      return run;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Run ${runId} did not settle within 180 seconds`);
}

const evaluationId = randomUUID();
const project = await request(
  "/v1/projects",
  {
    method: "POST",
    body: JSON.stringify({ name: `Coding eval ${evaluationId.slice(0, 8)}` }),
  },
  201,
);

async function evaluate(task) {
  const startedAt = performance.now();
  try {
    const session = await request(
      `/v1/projects/${encodeURIComponent(project.projectId)}/sessions`,
      {
        method: "POST",
        body: JSON.stringify({ workspaceId: project.workspaceId }),
      },
      201,
    );
    const accepted = await request(
      `/v1/sessions/${encodeURIComponent(session.sessionId)}/turns`,
      {
        method: "POST",
        headers: { "idempotency-key": `coding-eval-${evaluationId}-${task.id}` },
        body: JSON.stringify({ prompt: task.prompt }),
      },
      202,
    );
    const run = await waitForRun(accepted.runId);
    const [tests, versions] = await Promise.all([
      request(`/v1/runs/${encodeURIComponent(accepted.runId)}/test-results`),
      request(`/v1/sessions/${encodeURIComponent(session.sessionId)}/workspace-versions`),
    ]);
    const currentVersionId = versions.currentVersionId;
    let expectedEditPresent = false;
    if (typeof currentVersionId === "string") {
      const source = await request(
        `/v1/workspace-versions/${encodeURIComponent(currentVersionId)}/file?path=${encodeURIComponent(task.expectedFile)}`,
      );
      expectedEditPresent = source.toString("utf8").includes(task.expectedText);
    }
    const focused = tests.results.filter((result) => result.command === task.testCommand);
    const failedBeforeRepair = focused.some((result) => result.status !== "passed");
    const passedAfterRepair = focused.some((result) => result.status === "passed");
    const success =
      run.state === "completed" &&
      failedBeforeRepair &&
      passedAfterRepair &&
      expectedEditPresent &&
      typeof run.traceId === "string";
    return {
      taskId: task.id,
      success,
      runId: accepted.runId,
      traceId: run.traceId,
      runState: run.state,
      attempts: run.attemptCount,
      focusedTestResults: focused.map((result) => result.status),
      expectedEditPresent,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      taskId: task.id,
      success: false,
      failure: error instanceof Error ? error.message : "unknown_error",
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}

const results = new Array(manifest.tasks.length);
let nextTask = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, manifest.tasks.length) }, async () => {
    while (true) {
      const index = nextTask;
      nextTask += 1;
      if (index >= manifest.tasks.length) return;
      const result = await evaluate(manifest.tasks[index]);
      results[index] = result;
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }),
);

const successful = results.filter((result) => result.success).length;
const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
const percentile = (fraction) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)];
const report = {
  format: "agent-dock.coding-eval-report.v1",
  generatedAt: new Date().toISOString(),
  evaluationId,
  ...(registeredTenantSlug === undefined ? {} : { tenantSlug: registeredTenantSlug }),
  methodology: "deterministic_fake_model_full_agent_loop",
  modelIntelligenceBenchmark: false,
  taskCount: results.length,
  successful,
  successRate: successful / results.length,
  concurrency,
  p50DurationMs: percentile(0.5),
  p95DurationMs: percentile(0.95),
  results,
};
const markdown =
  `# AgentDock deterministic coding evaluation\n\n` +
  `Generated: ${report.generatedAt}\n\n` +
  `This measures the full durable Agent Loop and isolated tool execution with a scripted fake model. It does **not** claim model-intelligence quality.\n\n` +
  `- Tasks: ${report.taskCount}\n` +
  `- Success: ${report.successful}/${report.taskCount} (${(report.successRate * 100).toFixed(1)}%)\n` +
  `- Concurrency: ${report.concurrency}\n` +
  `- p50 / p95: ${report.p50DurationMs} ms / ${report.p95DurationMs} ms\n` +
  `- Model requests / tokens / cost: ${report.totalModelRequests} / ${report.totalTokens} / ${report.totalCostMicrousd} µUSD\n\n` +
  `| Task | Result | Run | Attempts | Test sequence | Duration |\n` +
  `| --- | --- | --- | ---: | --- | ---: |\n` +
  results
    .map(
      (result) =>
        `| ${result.taskId} | ${result.success ? "pass" : "fail"} | ${result.runId ?? "-"} | ${result.attempts ?? "-"} | ${(result.focusedTestResults ?? []).join(" → ") || result.failure || "-"} | ${result.durationMs} ms |`,
    )
    .join("\n") +
  `\n`;

await mkdir(dirname(outputJson), { recursive: true });
await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(outputMarkdown, markdown, "utf8");
if (successful !== results.length) process.exitCode = 1;
