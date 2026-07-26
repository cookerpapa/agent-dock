import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  OfficialCubeSandboxRuntimeClient,
  workspaceVolumeId,
} from "../packages/sandbox-manager/src/index.ts";
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
  egressProxyIp: environment.AGENT_DOCK_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
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
    "affinity",
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

function currentCubeAssignment(metadata) {
  const records = [];
  for (const [key, raw] of Object.entries(metadata)) {
    if (!key.startsWith("agentdock.assignment.v1.")) continue;
    try {
      const parsed = JSON.parse(raw);
      if (
        Number.isSafeInteger(parsed?.fencingToken) &&
        parsed.fencingToken > 0 &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.activationId === "string" &&
        typeof parsed.attemptId === "string" &&
        typeof parsed.turnId === "string"
      ) {
        records.push(parsed);
      }
    } catch {
      throw new Error("Cube assignment inventory contained malformed managed metadata");
    }
  }
  records.sort((left, right) => right.fencingToken - left.fencingToken);
  if (records[0]?.fencingToken === records[1]?.fencingToken) {
    throw new Error("Cube assignment inventory contained an ambiguous highest fence");
  }
  return records[0];
}

function managedForSession(instances, sessionId) {
  return instances.filter((instance) => {
    const assignment = currentCubeAssignment(instance.metadata);
    return (
      instance.metadata["agentdock.managed"] === "true" &&
      instance.metadata["agentdock.provider"] === "cubesandbox" &&
      assignment?.sessionId === sessionId
    );
  });
}

function observeCubeSession(sessionId) {
  const controller = new AbortController();
  const observed = new Map();
  let failure;
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        for (const instance of managedForSession(await cube.list(), sessionId)) {
          const assignment = currentCubeAssignment(instance.metadata);
          const activationId = assignment?.activationId;
          if (activationId !== undefined) {
            observed.set(activationId, {
              activationId,
              sandboxId: instance.sandboxId,
              attemptId: assignment.attemptId,
              turnId: assignment.turnId,
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

async function waitForRunningCubeSession(sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const retained = managedForSession(await cube.list(), sessionId);
    if (retained.length === 1 && retained[0].state === "running") return retained[0];
    if (retained.length > 1) {
      throw new Error("Cube inventory retained more than one exact-Session microVM");
    }
    await wait(250);
  }
  throw new Error("Cube inventory did not retain one running exact-Session microVM");
}

async function destroyCubeSession(sessionId) {
  const retained = managedForSession(await cube.list(), sessionId);
  await Promise.allSettled(retained.map((instance) => cube.destroy(instance.sandboxId)));
  await waitForNoCubeSession(sessionId);
}

async function logicalSandboxIdForRun(runId) {
  const value = await psql(
    `select ra.sandbox_id
       from runs r
       join run_attempts ra
         on ra.run_id = r.id
        and ra.id = r.current_attempt_id
      where r.id = ${sqlLiteral(runId)}`,
  );
  assert.match(value, /^[0-9a-f-]{36}$/i);
  return value;
}

async function logicalSandboxIdsForSession(sessionId) {
  const values = await psql(
    `select distinct ra.sandbox_id
       from runs r
       join run_attempts ra on ra.run_id = r.id
      where r.session_id = ${sqlLiteral(sessionId)}
        and ra.sandbox_id is not null`,
  );
  if (values.length === 0) return [];
  const sandboxIds = values.split(/\r?\n/);
  for (const sandboxId of sandboxIds) assert.match(sandboxId, /^[0-9a-f-]{36}$/i);
  return sandboxIds;
}

async function workspaceVersionEvidence(runId) {
  const value = await psql(
    `select v.file_count || '|' || a.size_bytes
       from workspace_versions v
       join artifacts a on a.id = v.workspace_artifact_id
      where v.run_id = ${sqlLiteral(runId)}
        and v.state = 'settled'`,
  );
  const [fileCount, artifactBytes] = value.split("|").map(Number);
  assert(Number.isSafeInteger(fileCount) && fileCount >= 0);
  assert(Number.isSafeInteger(artifactBytes) && artifactBytes > 0);
  return { fileCount, artifactBytes };
}

async function eraseLocalWorkspaceCopy(tenant, workspaceId, sessionId) {
  const volumeId = workspaceVolumeId({ tenantId: tenant, workspaceId, sessionId });
  const volumeRoot = resolve(runtimeDirectory, "state/cube-shared/volume");
  const volumePath = resolve(volumeRoot, `agentdock-posix-${volumeId}`);
  assert(
    volumePath.startsWith(`${volumeRoot}/`),
    "Local Workspace fault target escaped the shared-volume root",
  );
  const metadata = await lstat(volumePath);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  const entries = await readdir(volumePath);
  for (const entry of entries) {
    assert(entry !== "." && entry !== ".." && !entry.includes("/"));
    await rm(resolve(volumePath, entry), { recursive: true, force: true });
  }
  return { volumeId, removedEntries: entries.length };
}

async function terminateLogicalSandbox(logicalSandboxId, sessionId, required) {
  const source = `
    import { readFileSync } from "node:fs";
    import { randomUUID } from "node:crypto";
    const sandboxId = ${JSON.stringify(logicalSandboxId)};
    const sessionId = ${JSON.stringify(sessionId)};
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
    const assignments = listed.assignments.filter(
      (assignment) => assignment.sessionId === sessionId,
    );
    if (assignments.length > 1 || (${JSON.stringify(required)} && assignments.length !== 1)) {
      throw new Error("Expected one exact-Session warm assignment, got " + assignments.length);
    }
    if (assignments.length === 0) process.exit(0);
    const assignment = assignments[0];
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

async function terminateWarmCubeSession(runId, sessionId) {
  await terminateLogicalSandbox(await logicalSandboxIdForRun(runId), sessionId, true);
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
      await waitForRunningCubeSession(sessionId);
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
let largeSession;

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
  assert(finalSource.includes("counting_sort"));
  assert(
    followUp.terminal.payload.workspacePatch.patch.includes("4, -1, 4, 0, -1") ||
      followUp.events.some(
        (event) =>
          event.type === "tool.completed" &&
          JSON.stringify(event.payload).includes("4, -1, 4, 0, -1"),
      ),
    "Follow-up did not exercise the requested duplicate-negative regression input",
  );

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

  largeSession = await api.createSession(project);
  const largeFirst = await runTurn(
    largeSession.sessionId,
    [
      "Use bash and work in the current empty workspace.",
      "Shallow-clone https://github.com/temporalio/temporal into a directory named temporal.",
      "Count regular files under temporal and require the count to be greater than 512.",
      "Write checkpoint-marker.txt in the workspace root containing exactly LARGE-CHECKPOINT-OK.",
      "Do not delete or compact the cloned repository, and report the measured file count.",
    ].join(" "),
    0,
    true,
  );
  const largeFirstUsage = await api.getRunUsage(largeFirst.accepted.runId);
  const largeFirstWorkspace = await workspaceVersionEvidence(largeFirst.accepted.runId);
  assert(
    largeFirstWorkspace.fileCount > 512,
    "Large-workspace Run did not cross the portable checkpoint boundary",
  );
  assert(
    largeFirstWorkspace.artifactBytes <= 32 * 1_024 * 1_024,
    "Cube checkpoint reference exceeded its bounded transport",
  );
  await terminateWarmCubeSession(largeFirst.accepted.runId, largeSession.sessionId);
  await waitForNoCubeSession(largeSession.sessionId);
  const localCopyFault = await eraseLocalWorkspaceCopy(
    tenantId,
    largeSession.workspaceId,
    largeSession.sessionId,
  );
  assert(localCopyFault.removedEntries > 0, "Workspace fault injection removed no local data");

  const largeFollowUp = await runTurn(
    largeSession.sessionId,
    [
      "Use tools and continue from the existing large Workspace checkpoint.",
      "Do not clone the repository again.",
      "Read checkpoint-marker.txt and require it to equal LARGE-CHECKPOINT-OK.",
      "Count regular files under the existing temporal directory and require the count to be greater than 512.",
      "Write restore-proof.txt in the workspace root containing the marker and measured count, then read it back.",
    ].join(" "),
    largeFirst.cursor,
    true,
  );
  const largeFollowUpUsage = await api.getRunUsage(largeFollowUp.accepted.runId);
  const largeFollowUpWorkspace = await workspaceVersionEvidence(largeFollowUp.accepted.runId);
  assert(largeFollowUpWorkspace.fileCount > 512);
  assert.equal(largeFirst.activations.length, 1);
  assert.equal(largeFollowUp.activations.length, 1);
  assert.notEqual(
    largeFollowUp.activations[0].sandboxId,
    largeFirst.activations[0].sandboxId,
    "Large Workspace did not cold-restore into a fresh Cube VM",
  );
  assert.notEqual(
    largeFollowUp.activations[0].activationId,
    largeFirst.activations[0].activationId,
    "Large Workspace cold restore reused stale physical authority",
  );

  await waitForRunningCubeSession(session.sessionId);
  await waitForNoCubeSession(foreignSession.sessionId);
  const temporalWorkflows = await Promise.all(
    [
      chat.accepted,
      firstCoding.accepted,
      followUp.accepted,
      largeFirst.accepted,
      largeFollowUp.accepted,
    ].map((accepted) => temporalWorkflowEvidence(accepted)),
  );
  const usage = totalUsage(
    chatUsage.totals,
    firstUsage.totals,
    followUpUsage.totals,
    largeFirstUsage.totals,
    largeFollowUpUsage.totals,
  );
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
      runningSessionReuse: true,
      workspaceRestored: true,
      workspaceVersions: finalVersions.versions.length,
      finalFileBytes: Buffer.byteLength(finalSource, "utf8"),
    },
    multiTenant: {
      crossTenantConversationHidden: true,
      lowerLevelCubeTenantGate: 2,
    },
    largeWorkspace: {
      source: "github.com/temporalio/temporal",
      firstRunId: largeFirst.accepted.runId,
      followUpRunId: largeFollowUp.accepted.runId,
      firstFileCount: largeFirstWorkspace.fileCount,
      restoredFileCount: largeFollowUpWorkspace.fileCount,
      checkpointReferenceBytes: largeFirstWorkspace.artifactBytes,
      sourceSandboxDestroyed: true,
      localPosixCopyErased: true,
      localPosixEntriesErased: localCopyFault.removedEntries,
      volumeId: localCopyFault.volumeId,
      restoredFromKopia: true,
      freshCubeMicroVm: true,
      higherFenceActivation: true,
      firstUsage: largeFirstUsage.totals,
      followUpUsage: largeFollowUpUsage.totals,
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
      retainedRunningSessionMicroVmCount: 1,
      foreignSessionMicroVmCount: 0,
      explicitWarmEvictionVerified: false,
    },
  };
  assert(usage.requests >= 3 && usage.inputTokens > 0 && usage.outputTokens > 0);
  await terminateWarmCubeSession(followUp.accepted.runId, session.sessionId);
  await waitForNoCubeSession(session.sessionId);
  await terminateWarmCubeSession(largeFollowUp.accepted.runId, largeSession.sessionId);
  await waitForNoCubeSession(largeSession.sessionId);
  report.cleanup.explicitWarmEvictionVerified = true;
  report.cleanup.retainedRunningSessionMicroVmCount = 0;

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
        `- Same running Session Cube KVM guest reused: ${String(report.multiRound.sameCubeMicroVm)}`,
        `- Workspace restored across Runs: ${String(report.multiRound.workspaceRestored)}`,
        `- Large Workspace files / checkpoint reference: ${String(report.largeWorkspace.firstFileCount)} / ${String(report.largeWorkspace.checkpointReferenceBytes)} bytes`,
        `- Large Workspace fresh-VM cold restore: ${String(report.largeWorkspace.freshCubeMicroVm)}`,
        `- Real input/output/cache-read tokens: ${String(report.totalUsage.inputTokens)} / ${String(report.totalUsage.outputTokens)} / ${String(report.totalUsage.cacheReadTokens)}`,
        `- Semantic compaction: ${String(report.semanticConversation.projectedSourceEvents)} source events -> ${String(report.semanticConversation.semanticItems)} transcript items`,
        `- Temporal Workflows / bounded-reference histories: ${String(report.temporal.workflows.length)} / ${String(report.temporal.workflows.filter((workflow) => workflow.boundedReferencesOnly).length)}`,
        `- Cross-tenant conversation hidden: ${String(report.multiTenant.crossTenantConversationHidden)}`,
        `- Explicit warm eviction / remaining Cube microVMs: ${String(report.cleanup.explicitWarmEvictionVerified)} / ${String(report.cleanup.retainedRunningSessionMicroVmCount + report.cleanup.foreignSessionMicroVmCount)}`,
        "",
        "A real-model chat Run completed without touching Cube. Two coding Runs reused one running Session-bound Cube KVM guest through a checkpoint boundary, rotated Tool authority and higher-fence rebind. A separate Run cloned the Temporal repository beyond the portable checkpoint limit; after explicit source-VM destruction and deletion of its local POSIX Workspace copy, its follow-up restored the marker and repository from the committed Kopia snapshot into a fresh Cube VM under a higher-fence activation. All Runs completed through Temporal with bounded-reference histories. Provider usage, semantic projections, cross-tenant API denial and explicit warm eviction were verified.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  // Release Manager ownership/admission first, then use the native Cube API
  // only as an orphan fallback. Reversing this order would strand a warm
  // in-memory handle until the Manager's TTL/restart.
  for (const logicalSandboxId of await logicalSandboxIdsForSession(session.sessionId).catch(
    () => [],
  )) {
    await terminateLogicalSandbox(logicalSandboxId, session.sessionId, false).catch(
      () => undefined,
    );
  }
  await destroyCubeSession(session.sessionId).catch(() => undefined);
  if (largeSession !== undefined) {
    for (const logicalSandboxId of await logicalSandboxIdsForSession(largeSession.sessionId).catch(
      () => [],
    )) {
      await terminateLogicalSandbox(logicalSandboxId, largeSession.sessionId, false).catch(
        () => undefined,
      );
    }
    await destroyCubeSession(largeSession.sessionId).catch(() => undefined);
  }
  await cube.close();
}
