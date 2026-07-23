import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { AgentDockApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.AGENT_DOCK_LIVE_SEMANTIC_CHECK !== "1") {
  throw new Error(
    "Set AGENT_DOCK_LIVE_SEMANTIC_CHECK=1 to acknowledge real model and gVisor usage",
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
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const controller = new AbortController();
  let timeoutFailure;
  const timer = setTimeout(() => {
    timeoutFailure = new Error("Live semantic conversation turn timed out");
    controller.abort(timeoutFailure);
  }, 600_000);
  timer.unref();
  const events = [];
  let firstTextAt;
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
        if (event.turnId === accepted.turnId && event.type === "assistant.text.delta") {
          firstTextAt ??= performance.now();
        }
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
      throw new Error(
        `Run ${failedRun.runId} ended as ${failedRun.state}${
          failedRun.failure === undefined
            ? ""
            : ` (${failedRun.failure.code}: ${failedRun.failure.message ?? "no detail"})`
        }`,
      );
    }
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    assert(firstTextAt !== undefined, "Turn did not stream assistant text");
    return {
      accepted,
      cursor,
      events,
      terminal,
      firstTextMs: Math.round(firstTextAt - submittedAt),
      settledMs: Math.round(performance.now() - submittedAt),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await monitor;
  }
}

async function managedSandboxPods() {
  const value = JSON.parse(
    await capture(
      "kubectl",
      [
        "--kubeconfig",
        kubeconfigPath,
        "get",
        "pods",
        "--namespace",
        "agent-dock-sandboxes",
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

async function sessionSandboxPods(sessionId) {
  return (await managedSandboxPods()).filter(
    (pod) => pod?.metadata?.annotations?.["agent-dock.io/session-id"] === sessionId,
  );
}

function sandboxIdentity(pod, sessionId) {
  const metadata = pod?.metadata;
  const annotations = metadata?.annotations;
  assert.equal(annotations?.["agent-dock.io/session-id"], sessionId);
  assert.equal(pod?.spec?.runtimeClassName, "agent-dock-gvisor");
  for (const value of [metadata?.name, metadata?.uid, annotations?.["agent-dock.io/sandbox-id"]]) {
    assert.equal(typeof value, "string");
    assert(value.length > 0);
  }
  return {
    name: metadata.name,
    uid: metadata.uid,
    sandboxId: annotations["agent-dock.io/sandbox-id"],
  };
}

async function waitForSessionSandbox(sessionId) {
  const deadline = Date.now() + 15_000;
  while (true) {
    const matches = await sessionSandboxPods(sessionId);
    if (matches.length === 1) return sandboxIdentity(matches[0], sessionId);
    if (matches.length > 1) throw new Error("A Session owns more than one warm Tool Sandbox");
    if (Date.now() >= deadline) {
      throw new Error("The coding turn did not retain one warm Tool Sandbox");
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

async function terminateSessionSandbox(sessionId, sandbox) {
  const listed = await sandboxManagerInventory({
    protocolVersion: 1,
    type: "assignments.list",
    requestId: randomUUID(),
    sandboxId: sandbox.sandboxId,
  });
  assert.equal(listed.type, "assignments.listed");
  const matches = listed.assignments.filter((assignment) => assignment.sessionId === sessionId);
  assert.equal(matches.length, 1, "Sandbox inventory did not contain the Session assignment");
  assert.equal(matches[0].containerId, sandbox.uid);
  const absent = await sandboxManagerInventory({
    protocolVersion: 1,
    type: "assignment.terminate_and_confirm",
    requestId: randomUUID(),
    sandboxId: sandbox.sandboxId,
    assignment: matches[0],
  });
  assert.equal(absent.type, "assignment.absent");
  assert.equal(absent.containerId, sandbox.uid);
}

async function bestEffortCleanup(sessionId, knownSandbox) {
  try {
    const matches = await sessionSandboxPods(sessionId);
    const sandbox =
      knownSandbox ?? (matches.length === 1 ? sandboxIdentity(matches[0], sessionId) : undefined);
    if (sandbox !== undefined) await terminateSessionSandbox(sessionId, sandbox);
  } catch {
    // Preserve the original acceptance failure; the production Reaper remains the fallback.
  }
}

const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");
const suffix = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
const project = await api.createProject(`Semantic conversation acceptance ${suffix}`);
const session = await api.createSession(project);
let retainedSandbox;

try {
  assert.equal((await sessionSandboxPods(session.sessionId)).length, 0);
  const chat = await runTurn(
    session.sessionId,
    "Do not call any tool. Reply with exactly this text and nothing else: semantic-chat-ok",
    0,
  );
  assert.equal(
    chat.events.filter((event) => event.type === "tool.started").length,
    0,
    "Pure chat unexpectedly activated a Tool Sandbox",
  );
  assert.equal(
    (await sessionSandboxPods(session.sessionId)).length,
    0,
    "Pure chat retained a Tool Sandbox",
  );
  const chatUsage = await api.getRunUsage(chat.accepted.runId);
  assert(chatUsage.totals.requests > 0 && chatUsage.totals.outputTokens > 0);

  const afterChat = await api.getConversation(session.sessionId);
  assert.equal(afterChat.turns.length, 1);
  assert(afterChat.turns[0]?.transcript !== undefined);
  assert(
    afterChat.turns[0]?.transcript?.items.some(
      (item) => item.kind === "text" && item.text.includes("semantic-chat-ok"),
    ),
    "Pure-chat semantic transcript omitted the assistant answer",
  );
  assert(
    !afterChat.turns[0]?.transcript?.items.some((item) => item.kind === "tool"),
    "Pure-chat semantic transcript contained a tool",
  );
  assert.equal(afterChat.replayAfterSequence, chat.cursor);

  const coding = await runTurn(
    session.sessionId,
    [
      "Work in the current workspace.",
      "Create semantic-projection-check.txt containing exactly semantic-projection-ok followed by one newline.",
      'Use bash to verify it with: test "$(cat semantic-projection-check.txt)" = semantic-projection-ok.',
      "Do not only describe the change; execute the verification.",
    ].join(" "),
    chat.cursor,
  );
  const toolCalls = coding.events.filter((event) => event.type === "tool.started").length;
  assert(toolCalls > 0, "Coding turn did not execute a Tool Sandbox tool");
  assert(
    coding.events.some((event) => event.type === "tool.completed"),
    "Coding turn did not complete a Tool Sandbox tool",
  );
  const patch = coding.terminal.payload.workspacePatch?.patch;
  assert.equal(typeof patch, "string");
  assert(patch.includes("semantic-projection-check.txt"));
  const codingUsage = await api.getRunUsage(coding.accepted.runId);
  assert(codingUsage.totals.requests > 0 && codingUsage.totals.outputTokens > 0);

  retainedSandbox = await waitForSessionSandbox(session.sessionId);
  const conversation = await api.getConversation(session.sessionId);
  assert.equal(conversation.turns.length, 2);
  assert(
    conversation.turns.every((turn) => turn.transcript !== undefined),
    "Completed turns did not expose semantic transcript projections",
  );
  assert(
    conversation.turns[1]?.transcript?.items.some((item) => item.kind === "tool"),
    "Coding semantic transcript omitted tool execution",
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
  assert.equal(projectionCount, 2);
  assert(projectedSourceEvents > semanticItems, "Semantic projection did not compact event deltas");
  const durableEventEvidence = await psql(
    `select count(*) || '|' || coalesce(max(seq), 0)
       from session_events
      where tenant_id = ${sqlLiteral(tenantId)}
        and session_id = ${sqlLiteral(session.sessionId)}`,
  );
  const [durableEvents, durableThroughSequence] = durableEventEvidence.split("|").map(Number);
  assert.equal(conversation.replayAfterSequence, durableThroughSequence);
  assert(projectedThroughSequence <= durableThroughSequence);

  const report = {
    accepted: true,
    checkedAt: new Date().toISOString(),
    endpoint: baseUrl.toString(),
    model: { provider: model.provider, modelId: model.modelId },
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
    chat: {
      runId: chat.accepted.runId,
      firstTextMs: chat.firstTextMs,
      settledMs: chat.settledMs,
      durableEvents: chat.events.length,
      toolCalls: 0,
      usage: chatUsage.totals,
      sandboxActivations: 0,
    },
    coding: {
      runId: coding.accepted.runId,
      firstTextMs: coding.firstTextMs,
      settledMs: coding.settledMs,
      durableEvents: coding.events.length,
      toolCalls,
      patchBytes: Buffer.byteLength(patch, "utf8"),
      usage: codingUsage.totals,
      sandboxRuntimeClass: "agent-dock-gvisor",
    },
    semanticConversation: {
      projectionCount,
      durableEvents,
      projectedSourceEvents,
      semanticItems,
      replayAfterSequence: conversation.replayAfterSequence,
    },
    cleanup: {
      sandboxUid: retainedSandbox.uid,
      exactAssignmentDestroyed: true,
    },
  };
  await terminateSessionSandbox(session.sessionId, retainedSandbox);
  retainedSandbox = undefined;
  assert.equal((await sessionSandboxPods(session.sessionId)).length, 0);

  const reportDirectory = resolve(repositoryRoot, "docs/reports");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "semantic-conversation-acceptance-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(reportDirectory, "semantic-conversation-acceptance-latest.md"),
    [
      "# Semantic conversation production acceptance",
      "",
      `- Checked at: ${report.checkedAt}`,
      `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
      `- Pure-chat first text / settled: ${String(report.chat.firstTextMs)} ms / ${String(report.chat.settledMs)} ms`,
      `- Pure-chat Sandbox activations: ${String(report.chat.sandboxActivations)}`,
      `- Coding first text / settled: ${String(report.coding.firstTextMs)} ms / ${String(report.coding.settledMs)} ms`,
      `- Coding Tool calls: ${String(report.coding.toolCalls)}`,
      `- Real input/output tokens: ${String(report.chat.usage.inputTokens + report.coding.usage.inputTokens)} / ${String(report.chat.usage.outputTokens + report.coding.usage.outputTokens)}`,
      `- Semantic compaction: ${String(report.semanticConversation.projectedSourceEvents)} source events -> ${String(report.semanticConversation.semanticItems)} transcript items`,
      `- Durable replay high-water: ${String(report.semanticConversation.replayAfterSequence)} / ${String(report.semanticConversation.durableEvents)} events`,
      `- Sandbox runtime: ${report.coding.sandboxRuntimeClass}`,
      `- Exact Sandbox cleanup: ${String(report.cleanup.exactAssignmentDestroyed)}`,
      "",
      "A real-model chat turn completed without provisioning a Sandbox. A second turn created and verified a file inside a gVisor Tool Sandbox. Both terminal turns committed semantic transcript projections, the conversation resumed SSE at the durable high-water mark without historical delta replay, real token usage was persisted, and the exact retained Sandbox assignment was destroyed.",
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (retainedSandbox !== undefined) {
    await bestEffortCleanup(session.sessionId, retainedSandbox);
  }
}
