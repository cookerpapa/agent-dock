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

function httpUrl(name, fallback) {
  const value = new URL(argument(name, fallback));
  if (value.protocol !== "http:" && value.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return value;
}

const baseUrl = httpUrl("--base-url", "http://127.0.0.1:8080");
const prometheusUrl = httpUrl("--prometheus-url", "http://127.0.0.1:9090");
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const tokenFile = resolve(argument("--token-file", resolve(runtimeDirectory, "secrets/api-token")));
const outputJson = resolve(
  repositoryRoot,
  argument("--output", "docs/reports/control-plane-load-latest.json"),
);
const outputMarkdown = outputJson.replace(/\.json$/, ".md");
const token = (await readFile(tokenFile, "utf8")).trim();
if (token.length < 32 || token.length > 512 || /[\x00-\x20\x7f]/.test(token)) {
  throw new Error("Load evaluation API credential is invalid");
}

async function request(path, options = {}, expectedStatus = 200) {
  const startedAt = performance.now();
  try {
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
        `${options.method ?? "GET"} ${path} returned ${String(response.status)}: ${bytes.toString("utf8").slice(0, 500)}`,
      );
    }
    return {
      success: true,
      durationMs: performance.now() - startedAt,
      body:
        bytes.length === 0 || !(response.headers.get("content-type") ?? "").includes("json")
          ? bytes
          : JSON.parse(bytes.toString("utf8")),
    };
  } catch (error) {
    return {
      success: false,
      durationMs: performance.now() - startedAt,
      failure: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(operation, concurrency, startedAt, results) {
  const durations = results.map((result) => result.durationMs);
  const elapsedMs = performance.now() - startedAt;
  const successful = results.filter((result) => result.success).length;
  return {
    operation,
    concurrency,
    requests: results.length,
    successful,
    errors: results.length - successful,
    elapsedMs: Math.round(elapsedMs),
    throughputPerSecond: Number(((results.length * 1_000) / elapsedMs).toFixed(2)),
    p50DurationMs: Math.round(percentile(durations, 0.5)),
    p95DurationMs: Math.round(percentile(durations, 0.95)),
    p99DurationMs: Math.round(percentile(durations, 0.99)),
    failures: results
      .filter((result) => !result.success)
      .slice(0, 5)
      .map((result) => result.failure),
  };
}

async function runConcurrent(operation, concurrency, operationFunction) {
  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, index) => operationFunction(index)),
  );
  return { summary: summarize(operation, concurrency, startedAt, results), results };
}

async function prometheusSnapshot() {
  const queries = {
    residentMemoryBytes: "max by (service) (process_resident_memory_bytes)",
    cpuSeconds: "sum by (service) (process_cpu_seconds_total)",
    eventLoopLagSeconds: "max by (service) (nodejs_eventloop_lag_seconds)",
  };
  const snapshot = {};
  for (const [name, query] of Object.entries(queries)) {
    try {
      const response = await fetch(
        new URL(`/api/v1/query?query=${encodeURIComponent(query)}`, prometheusUrl),
      );
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body = await response.json();
      snapshot[name] = body.data.result.map((sample) => ({
        service: sample.metric.service ?? "unknown",
        value: Number(sample.value[1]),
      }));
    } catch (error) {
      snapshot[name] = {
        unavailable: error instanceof Error ? error.message : "unknown_error",
      };
    }
  }
  return snapshot;
}

const evaluationId = randomUUID();
const projectResult = await request(
  "/v1/projects",
  {
    method: "POST",
    body: JSON.stringify({ name: `Load eval ${evaluationId.slice(0, 8)}` }),
  },
  201,
);
if (!projectResult.success) throw new Error(projectResult.failure);
const project = projectResult.body;
const stages = [];

for (const concurrency of [10, 50, 100]) {
  const creation = await runConcurrent("create_cold_session", concurrency, () =>
    request(
      `/v1/projects/${encodeURIComponent(project.projectId)}/sessions`,
      {
        method: "POST",
        body: JSON.stringify({ workspaceId: project.workspaceId }),
      },
      201,
    ),
  );
  const sessionIds = creation.results
    .filter((result) => result.success)
    .map((result) => result.body.sessionId);
  const reads = await runConcurrent("read_conversation", sessionIds.length, (index) =>
    request(`/v1/conversations/${encodeURIComponent(sessionIds[index])}`),
  );
  const stage = {
    concurrency,
    sessionCreation: creation.summary,
    conversationRead: reads.summary,
  };
  stages.push(stage);
  process.stdout.write(`${JSON.stringify(stage)}\n`);
}

await new Promise((resolvePromise) => setTimeout(resolvePromise, 16_000));
const metrics = await prometheusSnapshot();
const allSummaries = stages.flatMap((stage) => [stage.sessionCreation, stage.conversationRead]);
const report = {
  format: "pi-cloud.control-plane-load-report.v1",
  generatedAt: new Date().toISOString(),
  evaluationId,
  methodology: "loopback_http_cold_session_admission_and_tenant_scoped_reads",
  activeAgentRunBenchmark: false,
  host: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  },
  stages,
  totalRequests: allSummaries.reduce((sum, summary) => sum + summary.requests, 0),
  totalErrors: allSummaries.reduce((sum, summary) => sum + summary.errors, 0),
  prometheus: metrics,
};
const markdown =
  `# PiCloud control-plane load evaluation\n\n` +
  `Generated: ${report.generatedAt}\n\n` +
  `This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. ` +
  `It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.\n\n` +
  `- Requests: ${report.totalRequests}\n` +
  `- Errors: ${report.totalErrors}\n\n` +
  `| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |\n` +
  `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n` +
  allSummaries
    .map(
      (summary) =>
        `| ${summary.operation} | ${summary.concurrency} | ${summary.successful} | ${summary.errors} | ${summary.throughputPerSecond}/s | ${summary.p50DurationMs} ms | ${summary.p95DurationMs} ms | ${summary.p99DurationMs} ms |`,
    )
    .join("\n") +
  `\n`;

await mkdir(dirname(outputJson), { recursive: true });
await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(outputMarkdown, markdown, "utf8");
if (report.totalErrors !== 0) process.exitCode = 1;
