import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalReviewBundleManifestJson } from "@agent-dock/protocol";
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
const environment = Object.fromEntries(
  (await readFile(resolve(runtimeDirectory, ".env"), "utf8"))
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

function warmSandboxIdentity(pod, sessionId) {
  const metadata = pod?.metadata;
  const annotations = metadata?.annotations;
  assert.equal(annotations?.["agent-dock.io/session-id"], sessionId);
  assert.equal(pod?.spec?.runtimeClassName, "agent-dock-gvisor");
  for (const value of [
    metadata?.name,
    metadata?.uid,
    annotations?.["agent-dock.io/activation-id"],
    annotations?.["agent-dock.io/attempt-id"],
    annotations?.["agent-dock.io/environment-version-id"],
    annotations?.["agent-dock.io/environment-image-revision"],
    annotations?.["agent-dock.io/sandbox-id"],
  ]) {
    assert.equal(typeof value, "string");
    assert(value.length > 0);
  }
  const fencingToken = Number(annotations["agent-dock.io/fencing-token"]);
  assert(Number.isSafeInteger(fencingToken) && fencingToken > 0);
  return {
    name: metadata.name,
    uid: metadata.uid,
    activationId: annotations["agent-dock.io/activation-id"],
    attemptId: annotations["agent-dock.io/attempt-id"],
    environmentVersionId: annotations["agent-dock.io/environment-version-id"],
    environmentImageRevision: annotations["agent-dock.io/environment-image-revision"],
    sandboxId: annotations["agent-dock.io/sandbox-id"],
    fencingToken,
  };
}

async function waitForWarmSessionSandbox(sessionId) {
  const deadline = Date.now() + 15_000;
  while (true) {
    const matches = (await managedKubernetesPods("agent-dock-sandboxes")).filter(
      (pod) => pod?.metadata?.annotations?.["agent-dock.io/session-id"] === sessionId,
    );
    if (matches.length === 1) return warmSandboxIdentity(matches[0], sessionId);
    if (matches.length > 1) throw new Error("A Session owns more than one warm Tool Sandbox");
    if (Date.now() >= deadline) {
      throw new Error("The completed coding Session did not retain one warm Tool Sandbox");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

async function sandboxManagerInventory(request) {
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  const script = [
    "const {readFile}=await import('node:fs/promises');",
    "const token=(await readFile('/run/agent-dock-secrets/sandbox-manager-token','utf8')).trim();",
    "const request=JSON.parse(Buffer.from(process.env.AGENT_DOCK_ACCEPTANCE_REQUEST,'base64url').toString('utf8'));",
    "const response=await fetch('http://sandbox-manager:4300/internal/v1/sandbox-inventory',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(request)});",
    "const body=await response.text();",
    "if(!response.ok){process.stderr.write(body);process.exit(1)}",
    "process.stdout.write(body);",
  ].join("");
  return JSON.parse(
    await capture(
      process.execPath,
      [
        "scripts/production-compose.mjs",
        "exec",
        "-T",
        "-e",
        `AGENT_DOCK_ACCEPTANCE_REQUEST=${encodedRequest}`,
        "supervisor-host",
        "node",
        "--input-type=module",
        "--eval",
        script,
      ],
      60_000,
    ),
  );
}

async function terminateWarmSessionSandbox(sessionId, sandbox) {
  const listed = await sandboxManagerInventory({
    protocolVersion: 1,
    type: "assignments.list",
    requestId: crypto.randomUUID(),
    sandboxId: sandbox.sandboxId,
  });
  assert.equal(listed.type, "assignments.listed");
  const matches = listed.assignments.filter((assignment) => assignment.sessionId === sessionId);
  assert.equal(
    matches.length,
    1,
    "Sandbox inventory did not contain exactly one Session assignment",
  );
  assert.equal(matches[0].containerId, sandbox.uid);
  const absent = await sandboxManagerInventory({
    protocolVersion: 1,
    type: "assignment.terminate_and_confirm",
    requestId: crypto.randomUUID(),
    sandboxId: sandbox.sandboxId,
    assignment: matches[0],
  });
  assert.equal(absent.type, "assignment.absent");
  assert.equal(absent.containerId, sandbox.uid);

  const deadline = Date.now() + 15_000;
  while (true) {
    const survivors = (await managedKubernetesPods("agent-dock-sandboxes")).filter(
      (pod) => pod?.metadata?.annotations?.["agent-dock.io/session-id"] === sessionId,
    );
    if (survivors.length === 0) break;
    if (Date.now() >= deadline) throw new Error("Warm Tool Sandbox termination was not observed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  assert.equal((await managedKubernetesPods("agent-dock-importers")).length, 0);
}

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
const firstWarmSandbox = await waitForWarmSessionSandbox(session.sessionId);
assert.equal(
  firstWarmSandbox.environmentImageRevision,
  project.environment.imageRevision,
  "Warm Sandbox did not run the deployed immutable environment revision",
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
const secondWarmSandbox = await waitForWarmSessionSandbox(session.sessionId);
assert.equal(secondWarmSandbox.name, firstWarmSandbox.name);
assert.equal(secondWarmSandbox.uid, firstWarmSandbox.uid);
assert.equal(secondWarmSandbox.activationId, firstWarmSandbox.activationId);
assert.equal(secondWarmSandbox.environmentVersionId, firstWarmSandbox.environmentVersionId);
assert.notEqual(secondWarmSandbox.attemptId, firstWarmSandbox.attemptId);
assert(secondWarmSandbox.fencingToken > firstWarmSandbox.fencingToken);

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
await terminateWarmSessionSandbox(session.sessionId, secondWarmSandbox);

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
  warmReuse: {
    podUid: secondWarmSandbox.uid,
    activationId: secondWarmSandbox.activationId,
    firstFence: firstWarmSandbox.fencingToken,
    secondFence: secondWarmSandbox.fencingToken,
    environmentVersionId: secondWarmSandbox.environmentVersionId,
    imageRevision: secondWarmSandbox.environmentImageRevision,
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
    `- Warm Pod reused: ${report.warmReuse.podUid}`,
    `- Fencing token advanced: ${String(report.warmReuse.firstFence)} -> ${String(report.warmReuse.secondFence)}`,
    `- First Review Bundle: ${report.firstTurn.reviewBundleId} (${report.firstTurn.reviewBundleSha256})`,
    `- Second Review Bundle: ${report.secondTurn.reviewBundleId} (${report.secondTurn.reviewBundleSha256})`,
    `- Exact Sandbox cleanup: ${String(report.warmReuse.cleaned)}`,
    "",
    "Both turns changed the imported Java repository, executed tools inside the credential-free gVisor Sandbox, committed immutable Review Bundles and semantic conversation projections, persisted real token usage, resumed SSE from the durable high-water mark without historical delta replay, reused the same physical Pod with a newer writer fence, and then destroyed that exact assignment.",
    "",
  ].join("\n"),
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
