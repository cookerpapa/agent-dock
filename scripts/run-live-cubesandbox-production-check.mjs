import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-manager/src/index.ts";
import { AgentDockApi, AgentDockApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.AGENT_DOCK_LIVE_CUBESANDBOX_CHECK !== "1") {
  throw new Error(
    "Set AGENT_DOCK_LIVE_CUBESANDBOX_CHECK=1 to acknowledge real model usage and Cube KVM execution",
  );
}
const writeReport = process.env.AGENT_DOCK_LIVE_CUBESANDBOX_REPORT !== "0";

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
const cluster = parseJson(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/cluster.json"),
    64 * 1_024,
    "Cube cluster evidence",
  ),
  "Cube cluster evidence",
);
const template = parseJson(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/template.json"),
    64 * 1_024,
    "Cube template evidence",
  ),
  "Cube template evidence",
);
const cubeApiKey = (
  await readPrivate(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), 4_096, "Cube API key")
).replace(/\r?\n$/, "");

if (
  cluster?.formatVersion !== 1 ||
  cluster?.cubeCommit !== "8721dd151971ce3c2966482bbd32904ad98f378e" ||
  cluster?.podNetworkMtu !== 1_450 ||
  template?.formatVersion !== 1 ||
  template?.cubeCommit !== cluster.cubeCommit ||
  !/^tpl-[a-z0-9]{24}$/.test(template?.templateId ?? "") ||
  !/^sha256:[a-f0-9]{64}$/.test(template?.imageDigest ?? "")
) {
  throw new Error("Cube production evidence is invalid");
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
const token = (
  await readPrivate(resolve(runtimeDirectory, "secrets/api-token"), 4_096, "Production API token")
).trim();
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);
const api = new AgentDockApi(fetchFromProduction, token);
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${String(cluster.api.port)}`,
  apiKey: cubeApiKey,
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  requestTimeoutMs: 30_000,
});

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 1 * 1_024 * 1_024,
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

function decodeTemporalPayloads(value, decoded = []) {
  if (Array.isArray(value)) {
    for (const item of value) decodeTemporalPayloads(item, decoded);
    return decoded;
  }
  if (typeof value !== "object" || value === null) return decoded;
  if (Array.isArray(value.payloads)) {
    for (const payload of value.payloads) {
      if (typeof payload?.data === "string") {
        decoded.push(Buffer.from(payload.data, "base64").toString("utf8"));
      }
    }
  }
  for (const child of Object.values(value)) decodeTemporalPayloads(child, decoded);
  return decoded;
}

async function temporalWorkflowEvidence(accepted) {
  const workflowId = `agent-dock-run-v1-${accepted.runId}`;
  const history = parseJson(
    await capture(
      process.execPath,
      [
        "scripts/production-compose.mjs",
        "exec",
        "-T",
        "temporal",
        "temporal",
        "workflow",
        "show",
        "--namespace",
        "agent-dock",
        "--workflow-id",
        workflowId,
        "--address",
        "127.0.0.1:7233",
        "--output",
        "json",
      ],
      30_000,
    ),
    "Temporal Workflow history",
  );
  const decoded = decodeTemporalPayloads(history);
  const allowedKeys = new Set([
    "schemaVersion",
    "tenantId",
    "sessionId",
    "runId",
    "commandId",
    "status",
    "attempt",
    "failureCode",
    "retryAfterMs",
  ]);
  for (const payload of decoded) {
    assert(Buffer.byteLength(payload, "utf8") <= 2_048);
    const parsed = parseJson(payload, "Temporal Workflow payload");
    assert(
      Object.keys(parsed).every((key) => allowedKeys.has(key)),
      `Temporal history contains a forbidden payload field: ${Object.keys(parsed).join(",")}`,
    );
  }
  assert(decoded.some((payload) => payload.includes(accepted.runId)));
  assert(
    history.events.some((event) => event.eventType === "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED"),
  );
  return {
    workflowId,
    historyEvents: history.events.length,
    decodedPayloads: decoded.length,
    boundedReferencesOnly: true,
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

function managedForSession(instances, sessionId) {
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
        for (const instance of managedForSession(await cube.list(), sessionId)) {
          const activationId = instance.metadata["agentdock.activation_id"];
          if (activationId !== undefined) {
            observed.set(activationId, {
              activationId,
              sandboxId: instance.sandboxId,
              attemptId: instance.metadata["agentdock.attempt_id"],
              turnId: instance.metadata["agentdock.turn_id"],
              state: instance.state,
            });
          }
        }
      } catch (error) {
        failure = error;
        controller.abort();
        return;
      }
      await wait(100, controller.signal);
    }
  })();
  return {
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
    const remaining = managedForSession(await cube.list(), sessionId);
    if (remaining.length === 0) return;
    await wait(250);
  }
  throw new Error("Cube inventory retained a settled Session microVM");
}

async function waitForPausedCubeSession(sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const retained = managedForSession(await cube.list(), sessionId);
    if (retained.length === 1 && retained[0].state === "paused") return retained[0];
    if (retained.length > 1) {
      throw new Error("Cube inventory retained more than one exact-Session microVM");
    }
    await wait(250);
  }
  throw new Error("Cube inventory did not reach one sealed paused exact-Session microVM");
}

async function terminateWarmCubeSession(sandboxId) {
  assert(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?$/.test(sandboxId));
  const source = `
    import { readFileSync } from "node:fs";
    import { randomUUID } from "node:crypto";
    const sandboxId = ${JSON.stringify(sandboxId)};
    const token = readFileSync(
      "/run/agent-dock-secrets/sandbox-manager-token",
      "utf8",
    ).trim();
    const endpoint = "http://127.0.0.1:4300/internal/v1/sandbox-inventory";
    const send = async (body) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(value));
      return value;
    };
    const listed = await send({
      protocolVersion: 1,
      type: "assignments.list",
      requestId: randomUUID(),
      sandboxId,
    });
    if (listed.assignments.length !== 1) {
      throw new Error("Expected one warm assignment, got " + listed.assignments.length);
    }
    const assignment = listed.assignments[0];
    await send({
      protocolVersion: 1,
      type: "assignment.terminate_and_confirm",
      requestId: randomUUID(),
      sandboxId,
      assignment,
    });
  `;
  await capture(
    process.execPath,
    [
      "scripts/production-compose.mjs",
      "exec",
      "-T",
      "sandbox-manager",
      "node",
      "--input-type=module",
      "--eval",
      source,
    ],
    60_000,
  );
}

async function waitForDurableRunCompletion(runId) {
  const deadline = Date.now() + 60_000;
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
  throw new Error("Agent settled, but the durable Run did not commit within its deadline");
}

async function runTurn(sessionId, prompt, afterSequence, expectTools) {
  const observer = observeCubeSession(sessionId);
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const controller = new AbortController();
  let timeoutFailure;
  const timer = setTimeout(() => {
    timeoutFailure = new Error("Live Cube production turn timed out");
    controller.abort(timeoutFailure);
  }, 10 * 60_000);
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
        await wait(250, controller.signal);
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
    const toolCalls = events.filter((event) => event.type === "tool.started").length;
    if (expectTools) {
      assert(toolCalls > 0, "Coding turn did not execute a Tool operation");
      assert(
        events.some((event) => event.type === "tool.completed"),
        "Coding turn did not complete a Tool operation",
      );
      assert.equal(typeof terminal.payload.workspacePatch?.patch, "string");
      assert(terminal.payload.workspacePatch.patch.length > 0, "Coding turn had no patch");
    } else {
      assert.equal(toolCalls, 0, "Pure chat unexpectedly executed a Tool");
    }
    await waitForDurableRunCompletion(accepted.runId);
    if (expectTools) {
      await waitForPausedCubeSession(sessionId);
    } else {
      await waitForNoCubeSession(sessionId);
    }
    const activations = await observer.stop();
    return {
      accepted,
      cursor,
      events,
      terminal,
      toolCalls,
      activations,
      firstTextMs: Math.round(firstTextAt - submittedAt),
      settledMs: Math.round(performance.now() - submittedAt),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await monitor;
    await observer.stop().catch(() => undefined);
  }
}

function totalUsage(...usage) {
  return usage.reduce(
    (total, value) => ({
      requests: total.requests + value.requests,
      inputTokens: total.inputTokens + value.inputTokens,
      outputTokens: total.outputTokens + value.outputTokens,
      cacheReadTokens: total.cacheReadTokens + value.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + value.cacheWriteTokens,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

await cube.checkHealth();
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const project = await api.createProject(`Cube production acceptance ${suffix}`, { kind: "empty" });
const session = await api.createSession(project);

try {
  assert.equal(managedForSession(await cube.list(), session.sessionId).length, 0);

  const chat = await runTurn(
    session.sessionId,
    "Do not call any tool. Reply with exactly this text and nothing else: cube-chat-ok",
    0,
    false,
  );
  assert.equal(chat.activations.length, 0, "Pure chat created a Cube microVM");
  const chatUsage = await api.getRunUsage(chat.accepted.runId);
  assert(chatUsage.totals.requests > 0 && chatUsage.totals.outputTokens > 0);

  const firstCoding = await runTurn(
    session.sessionId,
    [
      "Work in the current empty workspace and use tools.",
      "Create counting_sort.py with a counting_sort(values) implementation that supports negative integers and duplicates.",
      "Include executable Python tests in the file for empty, sorted, reverse, negative, and duplicate inputs.",
      "Run python3 counting_sort.py and make every test pass.",
      "Do not only describe the code.",
    ].join(" "),
    chat.cursor,
    true,
  );
  assert.equal(
    firstCoding.activations.length,
    1,
    "First coding Run did not use exactly one Cube VM",
  );
  const firstUsage = await api.getRunUsage(firstCoding.accepted.runId);
  assert(firstUsage.totals.requests > 0 && firstUsage.totals.outputTokens > 0);
  const firstVersions = await api.listWorkspaceVersions(session.sessionId);
  assert(firstVersions.currentVersionId !== undefined, "First coding Run did not commit Workspace");
  const firstVersionId = firstVersions.currentVersionId;
  const firstFile = await api.readWorkspaceFile(firstVersionId, "counting_sort.py");
  const firstSource = Buffer.from(firstFile.bytes).toString("utf8");
  assert(firstSource.includes("counting_sort"), "First Workspace omitted counting_sort.py code");

  const followUp = await runTurn(
    session.sessionId,
    [
      "Read the existing counting_sort.py from the previous turn.",
      "Add a clearly named regression case or test called duplicate_negative_regression using exactly [4, -1, 4, 0, -1].",
      "Verify that its expected output is [-1, -1, 0, 4, 4].",
      "Run python3 counting_sort.py again and make all tests pass.",
      "Use tools and modify the existing file; do not recreate an unrelated implementation.",
    ].join(" "),
    firstCoding.cursor,
    true,
  );
  assert.equal(followUp.activations.length, 1, "Follow-up Run did not use exactly one Cube VM");
  assert.equal(
    followUp.activations[0].activationId,
    firstCoding.activations[0].activationId,
    "Two coding Runs did not reuse the same sealed Cube activation",
  );
  assert.equal(
    followUp.activations[0].sandboxId,
    firstCoding.activations[0].sandboxId,
    "Two coding Runs did not reuse the same Cube native sandbox",
  );
  const followUpUsage = await api.getRunUsage(followUp.accepted.runId);
  assert(followUpUsage.totals.requests > 0 && followUpUsage.totals.outputTokens > 0);
  const finalVersions = await api.listWorkspaceVersions(session.sessionId);
  assert(finalVersions.currentVersionId !== undefined);
  assert.notEqual(finalVersions.currentVersionId, firstVersionId);
  const finalFile = await api.readWorkspaceFile(finalVersions.currentVersionId, "counting_sort.py");
  const finalSource = Buffer.from(finalFile.bytes).toString("utf8");
  assert(finalSource.includes("duplicate_negative_regression"));
  assert(finalSource.includes("4, -1, 4, 0, -1"));

  const conversation = await api.getConversation(session.sessionId);
  assert.equal(conversation.turns.length, 3);
  assert(conversation.turns.every((turn) => turn.transcript !== undefined));
  assert.equal(conversation.replayAfterSequence, followUp.cursor);

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
  assert.equal(projectionCount, 3);
  assert(projectedSourceEvents > semanticItems);
  assert(projectedThroughSequence <= conversation.replayAfterSequence);

  const registration = await new AgentDockApi(fetchFromProduction).registerTenant(
    `cube-check-${suffix}`.replaceAll(/[^a-z0-9-]/g, "-").slice(0, 63),
    "Cube isolation acceptance tenant",
  );
  const foreignApi = new AgentDockApi(fetchFromProduction, registration.apiToken);
  const foreignProject = await foreignApi.createProject(`Foreign Cube project ${suffix}`, {
    kind: "empty",
  });
  const foreignSession = await foreignApi.createSession(foreignProject);
  await assert.rejects(
    api.getConversation(foreignSession.sessionId),
    (error) => error instanceof AgentDockApiError && error.status === 404,
  );
  await assert.rejects(
    foreignApi.getConversation(session.sessionId),
    (error) => error instanceof AgentDockApiError && error.status === 404,
  );

  const retained = await waitForPausedCubeSession(session.sessionId);
  await waitForNoCubeSession(foreignSession.sessionId);
  const temporalWorkflows = await Promise.all(
    [chat.accepted, firstCoding.accepted, followUp.accepted].map((accepted) =>
      temporalWorkflowEvidence(accepted),
    ),
  );
  const usage = totalUsage(chatUsage.totals, firstUsage.totals, followUpUsage.totals);
  const report = {
    accepted: true,
    checkedAt: new Date().toISOString(),
    upstream: "TencentCloud/CubeSandbox@v0.6.0",
    model: { provider: model.provider, modelId: model.modelId },
    pureChat: {
      firstTextMs: chat.firstTextMs,
      settledMs: chat.settledMs,
      toolCalls: chat.toolCalls,
      cubeActivations: chat.activations.length,
      usage: chatUsage.totals,
    },
    firstCoding: {
      firstTextMs: firstCoding.firstTextMs,
      settledMs: firstCoding.settledMs,
      toolCalls: firstCoding.toolCalls,
      cubeActivations: firstCoding.activations.length,
      patchBytes: Buffer.byteLength(firstCoding.terminal.payload.workspacePatch.patch, "utf8"),
      usage: firstUsage.totals,
    },
    followUpCoding: {
      firstTextMs: followUp.firstTextMs,
      settledMs: followUp.settledMs,
      toolCalls: followUp.toolCalls,
      cubeActivations: followUp.activations.length,
      patchBytes: Buffer.byteLength(followUp.terminal.payload.workspacePatch.patch, "utf8"),
      usage: followUpUsage.totals,
    },
    multiRound: {
      sameCubeMicroVm: true,
      sealedPauseResume: true,
      workspaceRestored: true,
      workspaceVersions: finalVersions.versions.length,
      finalFileBytes: Buffer.byteLength(finalSource, "utf8"),
    },
    multiTenant: {
      crossTenantConversationHidden: true,
      lowerLevelCubeTenantGate: 2,
    },
    semanticConversation: {
      projectionCount,
      projectedSourceEvents,
      semanticItems,
      replayAfterSequence: conversation.replayAfterSequence,
    },
    temporal: {
      scheduler: "Temporal",
      taskQueue: "agent-dock-pi-runs-v1",
      workflows: temporalWorkflows,
    },
    totalUsage: usage,
    cleanup: {
      retainedPausedSessionMicroVmCount: 1,
      foreignSessionMicroVmCount: 0,
      explicitWarmEvictionVerified: false,
    },
  };
  assert(usage.requests >= 3 && usage.inputTokens > 0 && usage.outputTokens > 0);
  await terminateWarmCubeSession(retained.sandboxId);
  await waitForNoCubeSession(session.sessionId);
  report.cleanup.explicitWarmEvictionVerified = true;
  report.cleanup.retainedPausedSessionMicroVmCount = 0;

  if (writeReport) {
    const reportDirectory = resolve(repositoryRoot, "docs/reports");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      resolve(reportDirectory, "cubesandbox-production-acceptance-latest.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      resolve(reportDirectory, "cubesandbox-production-acceptance-latest.md"),
      [
        "# CubeSandbox production acceptance",
        "",
        `- Checked at: ${report.checkedAt}`,
        `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
        `- Pure-chat first text / settled: ${String(report.pureChat.firstTextMs)} ms / ${String(report.pureChat.settledMs)} ms`,
        `- Pure-chat Tool calls / Cube activations: ${String(report.pureChat.toolCalls)} / ${String(report.pureChat.cubeActivations)}`,
        `- First coding first text / settled: ${String(report.firstCoding.firstTextMs)} ms / ${String(report.firstCoding.settledMs)} ms`,
        `- Follow-up first text / settled: ${String(report.followUpCoding.firstTextMs)} ms / ${String(report.followUpCoding.settledMs)} ms`,
        `- Coding Tool calls: ${String(report.firstCoding.toolCalls)} + ${String(report.followUpCoding.toolCalls)}`,
        `- Same sealed Cube KVM guest reused: ${String(report.multiRound.sameCubeMicroVm)}`,
        `- Workspace restored across Runs: ${String(report.multiRound.workspaceRestored)}`,
        `- Real input/output/cache-read tokens: ${String(report.totalUsage.inputTokens)} / ${String(report.totalUsage.outputTokens)} / ${String(report.totalUsage.cacheReadTokens)}`,
        `- Semantic compaction: ${String(report.semanticConversation.projectedSourceEvents)} source events -> ${String(report.semanticConversation.semanticItems)} transcript items`,
        `- Temporal Workflows / bounded-reference histories: ${String(report.temporal.workflows.length)} / ${String(report.temporal.workflows.filter((workflow) => workflow.boundedReferencesOnly).length)}`,
        `- Cross-tenant conversation hidden: ${String(report.multiTenant.crossTenantConversationHidden)}`,
        `- Explicit warm eviction / remaining Cube microVMs: ${String(report.cleanup.explicitWarmEvictionVerified)} / ${String(report.cleanup.retainedPausedSessionMicroVmCount + report.cleanup.foreignSessionMicroVmCount)}`,
        "",
        "A real-model chat Run completed without touching Cube. Two later coding Runs in the same Session reused one physical Cube KVM guest through a sealed pause/connect and higher-fence rebind; the follow-up read and modified the first Run's retained counting-sort file. All three Runs completed through Temporal, whose decoded histories contained only bounded references/status. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were all verified.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await waitForNoCubeSession(session.sessionId).catch(() => undefined);
  await cube.close();
}
