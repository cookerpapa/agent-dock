import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalReviewBundleManifestJson } from "@agent-dock/protocol";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-manager/src/index.ts";
import { AgentDockApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.AGENT_DOCK_LIVE_GITHUB_CHECK !== "1") {
  throw new Error(
    "Set AGENT_DOCK_LIVE_GITHUB_CHECK=1 to acknowledge public GitHub access and real model usage",
  );
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

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
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
const repository =
  process.env.AGENT_DOCK_LIVE_GITHUB_REPOSITORY ?? "mathewjonas/java-calculator-junit";
const commitSha =
  process.env.AGENT_DOCK_LIVE_GITHUB_COMMIT_SHA ?? "0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb";
if (
  !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(
    repository,
  ) ||
  repository.includes("..") ||
  repository.endsWith(".git") ||
  !/^[0-9a-f]{40}$/.test(commitSha)
) {
  throw new Error("Live GitHub repository source is invalid");
}
const bindAddress = environment.AGENT_DOCK_HTTP_BIND_ADDRESS;
const port = environment.AGENT_DOCK_HTTP_PORT;
const tenantId = environment.AGENT_DOCK_TENANT_ID;
if (bindAddress === undefined || port === undefined || tenantId === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const token = (await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8")).trim();
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);
const api = new AgentDockApi(fetchFromProduction, token);
const cubeCluster = parseJson(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/cluster.json"),
    64 * 1_024,
    "Cube cluster evidence",
  ),
  "Cube cluster evidence",
);
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cubeCluster.api.host}:${String(cubeCluster.api.port)}`,
  apiKey: (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/cubesandbox-api-key"),
      4_096,
      "Cube API key",
    )
  ).replace(/\r?\n$/, ""),
  proxyNodeIp: cubeCluster.proxy.host,
  proxyPort: cubeCluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cubeCluster.sandboxDomain,
  egressProxyIp: environment.AGENT_DOCK_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
  requestTimeoutMs: 30_000,
});
const kubeconfigPath = resolve(runtimeDirectory, "kubernetes/sandbox-manager.kubeconfig");
const executionEnvironment = {
  ...process.env,
  NO_PROXY: [process.env.NO_PROXY, "agent-dock-kubernetes", "127.0.0.1", "localhost"]
    .filter(Boolean)
    .join(","),
};

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: executionEnvironment,
        encoding: "utf8",
        maxBuffer: 1_024 * 1_024,
        timeout: timeoutMs,
      },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout.trim());
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

function waitForPoll(delayMs, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    timer.unref();
    function settle() {
      clearTimeout(timer);
      signal.removeEventListener("abort", settle);
      resolvePromise();
    }
    signal.addEventListener("abort", settle, { once: true });
  });
}

async function runTurn(sessionId, prompt, afterSequence) {
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const controller = new AbortController();
  let timeoutFailure;
  const timer = setTimeout(() => {
    timeoutFailure = new Error("Live GitHub turn timed out");
    controller.abort(timeoutFailure);
  }, 600_000);
  timer.unref();
  const events = [];
  let terminal;
  let failedRun;
  let monitorFailure;
  const monitor = (async () => {
    try {
      while (!controller.signal.aborted) {
        const run = await api.getRun(accepted.runId);
        if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
          failedRun = run;
          controller.abort();
          return;
        }
        await waitForPoll(250, controller.signal);
      }
    } catch (error) {
      monitorFailure = error;
      controller.abort();
    }
  })();
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
        events.push(event);
        if (
          event.turnId === accepted.turnId &&
          (event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled")
        ) {
          terminal = event;
          controller.abort();
        }
      },
    });
    await monitor;
    if (monitorFailure !== undefined) throw monitorFailure;
    if (timeoutFailure !== undefined) throw timeoutFailure;
    if (failedRun !== undefined) {
      const failure = failedRun.failure;
      throw new Error(
        `Run ${failedRun.runId} ended as ${failedRun.state}${
          failure === undefined
            ? ""
            : ` (${failure.code}${failure.message === undefined ? "" : `: ${failure.message}`})`
        }`,
      );
    }
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    const patch = terminal.payload.workspacePatch?.patch;
    assert.equal(typeof patch, "string");
    assert(patch.length > 0, "Real Pi turn returned an empty workspace patch");
    assert(
      events.some((event) => event.type === "tool.started"),
      "Pi did not start a tool",
    );
    assert(
      events.some((event) => event.type === "tool.completed"),
      "Pi did not complete a tool",
    );
    return {
      accepted,
      cursor,
      eventCount: events.length,
      toolCalls: events.filter((event) => event.type === "tool.started").length,
      patchBytes: Buffer.byteLength(patch, "utf8"),
      patch,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await monitor;
  }
}

async function waitForReviewBundle(runId) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const bundle = await api.getRunReviewBundle(runId);
      const canonical = canonicalReviewBundleManifestJson(bundle.manifest);
      const calculated = createHash("sha256").update(canonical, "utf8").digest("hex");
      assert.equal(bundle.manifestSha256, calculated, "Review Bundle integrity hash is invalid");
      assert.equal(bundle.manifest.run.runId, runId);
      assert.equal(
        bundle.manifest.attempts.filter((attempt) => attempt.projection === "canonical").length,
        1,
      );
      assert(bundle.manifest.assistant.text.length > 0, "Review Bundle omitted the final answer");
      assert(bundle.manifest.usage.requests > 0, "Review Bundle omitted real model usage");
      assert(bundle.manifest.usage.outputTokens > 0, "Review Bundle omitted output tokens");
      const repeated = await api.getRunReviewBundle(runId);
      assert.deepEqual(repeated, bundle, "Review Bundle changed after its immutable commit");
      return bundle;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

async function managedKubernetesPods(namespace) {
  const value = JSON.parse(
    await capture(
      "kubectl",
      [
        "--kubeconfig",
        kubeconfigPath,
        "get",
        "pods",
        "--namespace",
        namespace,
        "--selector",
        "agent-dock.io/managed=true",
        "--output=json",
      ],
      60_000,
    ),
  );
  assert(value !== null && typeof value === "object" && Array.isArray(value.items));
  return value.items;
}

function managedCubeForSession(instances, sessionId) {
  return instances.filter(
    (instance) =>
      instance.metadata["agentdock.managed"] === "true" &&
      instance.metadata["agentdock.provider"] === "cubesandbox" &&
      instance.metadata["agentdock.session_id"] === sessionId,
  );
}

function observeCubeSession(sessionId) {
  const controller = new AbortController();
  const observed = new Map();
  let failure;
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        for (const instance of managedCubeForSession(await cube.list(), sessionId)) {
          const activationId = instance.metadata["agentdock.activation_id"];
          if (activationId !== undefined) {
            observed.set(activationId, {
              activationId,
              sandboxId: instance.sandboxId,
              attemptId: instance.metadata["agentdock.attempt_id"],
              turnId: instance.metadata["agentdock.turn_id"],
              fencingToken: Number(instance.metadata["agentdock.fencing_token"]),
              imageRevision: instance.metadata["agentdock.image_revision"],
            });
          }
        }
      } catch (error) {
        failure = error;
        controller.abort();
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  })();
  return {
    values() {
      return [...observed.values()];
    },
    async stop() {
      controller.abort();
      await task;
      if (failure !== undefined) throw failure;
      return [...observed.values()];
    },
  };
}

async function waitForNoCubeSession(sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (managedCubeForSession(await cube.list(), sessionId).length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Settled GitHub Session retained a Cube microVM");
}

await cube.checkHealth();
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");
const suffix = `${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
const project = await api.createProject(`GitHub import acceptance ${suffix}`, {
  kind: "github_public",
  repository,
  commitSha,
});
assert.equal(project.source.kind, "github_public");
assert.equal(project.source.status, "pending");
const session = await api.createSession(project);
const cubeObserver = observeCubeSession(session.sessionId);
const first = await runTurn(
  session.sessionId,
  [
    "Inspect this imported Java repository before editing it.",
    "Create a production Calculator at src/main/java/junit_project/Calculator.java with add, subtract, and multiply integer operations.",
    "Remove the duplicate Calculator implementation under src/test, and update the existing JUnit test to use the production class and cover multiplication.",
    "Add an executable test.sh that uses only the installed JDK (javac/java and a temporary output directory, without network or Maven downloads) to verify all three operations.",
    "Run ./test.sh and fix any failure. Do not edit generated target files. Make real file changes; do not only describe them.",
  ].join(" "),
  0,
);
const firstReviewBundle = await waitForReviewBundle(first.accepted.runId);
const sourceAfterFirst = await psql(
  `select status || '|' || object_key || '|' || sha256 || '|' || size_bytes || '|' || updated_at::text
     from workspace_sources
    where tenant_id = ${sqlLiteral(tenantId)}
      and workspace_id = ${sqlLiteral(project.workspaceId)}`,
);
assert.match(sourceAfterFirst, /^ready\|[A-Za-z0-9/_.-]+\|[0-9a-f]{64}\|[1-9][0-9]*\|/);
assert(first.patch.includes("src/main/java/junit_project/Calculator.java"));
assert(first.patch.includes("test.sh"));
assert(
  firstReviewBundle.manifest.changes.changedPaths.includes(
    "src/main/java/junit_project/Calculator.java",
  ),
);
assert(firstReviewBundle.manifest.changes.changedPaths.includes("test.sh"));
await waitForNoCubeSession(session.sessionId);
const firstCubeMatches = cubeObserver
  .values()
  .filter((sandbox) => sandbox.turnId === first.accepted.turnId);
assert.equal(firstCubeMatches.length, 1, "First GitHub Run did not use exactly one Cube microVM");
const firstCube = firstCubeMatches[0];
assert.equal(
  firstCube.imageRevision,
  project.environment.imageRevision,
  "Cube microVM did not run the deployed immutable environment revision",
);

const second = await runTurn(
  session.sessionId,
  "Continue in the same workspace. Add divideExact(int dividend, int divisor), throw ArithmeticException for zero, extend test.sh to verify a successful division and the zero-divisor failure, then run ./test.sh. Preserve and build on the prior turn's changes.",
  first.cursor,
);
const secondReviewBundle = await waitForReviewBundle(second.accepted.runId);
const sourceAfterSecond = await psql(
  `select status || '|' || object_key || '|' || sha256 || '|' || size_bytes || '|' || updated_at::text
     from workspace_sources
    where tenant_id = ${sqlLiteral(tenantId)}
      and workspace_id = ${sqlLiteral(project.workspaceId)}`,
);
assert.equal(
  sourceAfterSecond,
  sourceAfterFirst,
  "Follow-up turn unexpectedly re-imported the source",
);
assert(second.patch.includes("src/main/java/junit_project/Calculator.java"));
assert(second.patch.includes("test.sh"));
assert(
  secondReviewBundle.manifest.changes.changedPaths.includes(
    "src/main/java/junit_project/Calculator.java",
  ),
);
await waitForNoCubeSession(session.sessionId);
const observedCubeSandboxes = await cubeObserver.stop();
const secondCubeMatches = observedCubeSandboxes.filter(
  (sandbox) => sandbox.turnId === second.accepted.turnId,
);
assert.equal(secondCubeMatches.length, 1, "Second GitHub Run did not use exactly one Cube microVM");
const secondCube = secondCubeMatches[0];
assert.notEqual(secondCube.activationId, firstCube.activationId);
assert.notEqual(secondCube.sandboxId, firstCube.sandboxId);
assert.notEqual(secondCube.attemptId, firstCube.attemptId);
assert(secondCube.fencingToken > firstCube.fencingToken);

const conversation = await api.getConversation(session.sessionId);
assert.equal(conversation.project.source.kind, "github_public");
assert.equal(conversation.project.source.status, "ready");
assert.equal(conversation.turns.length, 2);
assert(
  conversation.turns.every((turn) => turn.transcript !== undefined),
  "Completed turns did not expose semantic transcript projections",
);
assert(
  conversation.turns.every((turn) => turn.transcript?.items.some((item) => item.kind === "tool")),
  "Semantic transcript omitted completed tool executions",
);
const projectionEvidence = await psql(
  `select count(*) || '|' || coalesce(sum(source_event_count), 0) || '|' ||
          coalesce(max(through_seq), 0) || '|' ||
          coalesce(sum(jsonb_array_length(transcript -> 'items')), 0)
     from conversation_turn_projections
    where tenant_id = ${sqlLiteral(tenantId)}
      and session_id = ${sqlLiteral(session.sessionId)}`,
);
const [projectionCount, projectedSourceEvents, projectedThroughSequence, semanticItems] =
  projectionEvidence.split("|").map(Number);
assert.equal(projectionCount, 2, "One semantic projection per completed turn was not committed");
assert(
  projectedSourceEvents > semanticItems,
  "Semantic transcript did not compact the source event stream",
);
const durableEventEvidence = await psql(
  `select count(*) || '|' || coalesce(max(seq), 0)
     from session_events
    where tenant_id = ${sqlLiteral(tenantId)}
      and session_id = ${sqlLiteral(session.sessionId)}`,
);
const [durableEvents, durableThroughSequence] = durableEventEvidence.split("|").map(Number);
assert.equal(
  conversation.replayAfterSequence,
  durableThroughSequence,
  "Conversation discovery would replay already projected history",
);
assert(
  projectedThroughSequence <= durableThroughSequence,
  "Projection high-water mark exceeded the durable event stream",
);
const usage = await psql(
  `select count(*) || '|' || coalesce(sum(input_tokens), 0) || '|' ||
          coalesce(sum(output_tokens), 0) || '|' || coalesce(sum(cache_read_tokens), 0) || '|' ||
          coalesce(sum(cache_write_tokens), 0)
     from usage_ledger
    where tenant_id = ${sqlLiteral(tenantId)}
      and session_id = ${sqlLiteral(session.sessionId)}`,
);
const [modelCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = usage
  .split("|")
  .map(Number);
assert(modelCalls > 0 && outputTokens > 0, "Real model token usage was not persisted");
assert.equal(
  firstReviewBundle.manifest.usage.requests + secondReviewBundle.manifest.usage.requests,
  modelCalls,
);
assert.equal(
  firstReviewBundle.manifest.usage.inputTokens + secondReviewBundle.manifest.usage.inputTokens,
  inputTokens,
);
assert.equal(
  firstReviewBundle.manifest.usage.outputTokens + secondReviewBundle.manifest.usage.outputTokens,
  outputTokens,
);
assert.equal((await managedKubernetesPods("agent-dock-importers")).length, 0);
await waitForNoCubeSession(session.sessionId);
await cube.close();

const report = {
  accepted: true,
  checkedAt: new Date().toISOString(),
  endpoint: baseUrl.toString(),
  model: { provider: model.provider, modelId: model.modelId },
  source: { repository, commitSha, status: conversation.project.source.status },
  projectId: project.projectId,
  workspaceId: project.workspaceId,
  sessionId: session.sessionId,
  firstTurn: {
    runId: first.accepted.runId,
    turnId: first.accepted.turnId,
    eventCount: first.eventCount,
    toolCalls: first.toolCalls,
    patchBytes: first.patchBytes,
    reviewBundleId: firstReviewBundle.reviewBundleId,
    reviewBundleSha256: firstReviewBundle.manifestSha256,
    changedPaths: firstReviewBundle.manifest.changes.changedPaths,
    tests: firstReviewBundle.manifest.tests.map((test) => ({
      suite: test.suite,
      status: test.status,
    })),
  },
  secondTurn: {
    runId: second.accepted.runId,
    turnId: second.accepted.turnId,
    eventCount: second.eventCount,
    toolCalls: second.toolCalls,
    patchBytes: second.patchBytes,
    reviewBundleId: secondReviewBundle.reviewBundleId,
    reviewBundleSha256: secondReviewBundle.manifestSha256,
    changedPaths: secondReviewBundle.manifest.changes.changedPaths,
    tests: secondReviewBundle.manifest.tests.map((test) => ({
      suite: test.suite,
      status: test.status,
    })),
  },
  usage: { modelCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
  semanticConversation: {
    projectionCount,
    durableEvents,
    projectedSourceEvents,
    semanticItems,
    replayAfterSequence: conversation.replayAfterSequence,
  },
  cubeExecution: {
    firstActivationId: firstCube.activationId,
    secondActivationId: secondCube.activationId,
    distinctMicroVms: firstCube.sandboxId !== secondCube.sandboxId,
    firstFence: firstCube.fencingToken,
    secondFence: secondCube.fencingToken,
    imageRevision: secondCube.imageRevision,
    cleaned: true,
  },
  sourceSnapshot: sourceAfterSecond.split("|").slice(0, 4).join("|"),
};
const reportDirectory = resolve(repositoryRoot, "docs/reports");
await mkdir(reportDirectory, { recursive: true });
await writeFile(
  resolve(reportDirectory, "real-model-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await writeFile(
  resolve(reportDirectory, "real-model-acceptance-latest.md"),
  [
    "# Real-model production acceptance",
    "",
    `- Checked at: ${report.checkedAt}`,
    `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
    `- Source: ${report.source.repository}@${report.source.commitSha}`,
    `- Model calls: ${String(report.usage.modelCalls)}`,
    `- Input/output tokens: ${String(report.usage.inputTokens)} / ${String(report.usage.outputTokens)}`,
    `- Semantic transcript: ${String(report.semanticConversation.projectedSourceEvents)} projected source events -> ${String(report.semanticConversation.semanticItems)} UI items`,
    `- Durable replay high-water: ${String(report.semanticConversation.replayAfterSequence)} / ${String(report.semanticConversation.durableEvents)} events`,
    `- Distinct Cube KVM microVMs: ${String(report.cubeExecution.distinctMicroVms)}`,
    `- Fencing token advanced: ${String(report.cubeExecution.firstFence)} -> ${String(report.cubeExecution.secondFence)}`,
    `- First Review Bundle: ${report.firstTurn.reviewBundleId} (${report.firstTurn.reviewBundleSha256})`,
    `- Second Review Bundle: ${report.secondTurn.reviewBundleId} (${report.secondTurn.reviewBundleSha256})`,
    `- Exact Sandbox cleanup: ${String(report.cubeExecution.cleaned)}`,
    "",
    "Both turns changed the imported Java repository, executed tools inside separate credential-free Cube KVM microVMs, committed immutable Review Bundles and semantic conversation projections, persisted real token usage, resumed SSE from the durable high-water mark without historical delta replay, restored the committed Workspace for the follow-up, and left no Tool microVM or importer behind.",
    "",
  ].join("\n"),
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
