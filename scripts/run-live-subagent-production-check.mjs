import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OfficialCubeSandboxRuntimeClient,
  workspaceVolumeId,
} from "../packages/tool-broker/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_SUBAGENT_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_SUBAGENT_CHECK=1 to acknowledge real model and Cube Subagent usage",
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
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximumBytes) {
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
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const databaseUrl = new URL(
  (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/database-url"),
      4_096,
      "Production database URL",
    )
  ).trim(),
);
const cluster = JSON.parse(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/cluster.json"),
    64 * 1_024,
    "Cube cluster evidence",
  ),
);
const cubeApiKey = (
  await readPrivate(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), 4_096, "Cube API key")
).trim();
const databaseUser = decodeURIComponent(databaseUrl.username);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
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

function capture(command, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(stderr.trim().slice(-2_000) || error.message));
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
    databaseUser,
    "--dbname",
    databaseName,
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

async function retireHistoricalAcceptanceCubes() {
  const rows = await psql(`
    select id::text from sessions where title like 'Subagent production acceptance %'
    union
    select execution.child_session_id::text
    from subagent_executions as execution
    join sessions as root on root.id = execution.root_session_id
    where root.title like 'Subagent production acceptance %'
  `);
  const acceptanceSessions = new Set(rows ? rows.split(/\r?\n/) : []);
  if (acceptanceSessions.size === 0) return;
  const cube = new OfficialCubeSandboxRuntimeClient({
    apiUrl: `http://${cluster.api.host}:${String(cluster.api.port)}`,
    apiKey: cubeApiKey,
    proxyNodeIp: cluster.proxy.host,
    proxyPort: cluster.proxy.port,
    proxyScheme: "http",
    sandboxDomain: cluster.sandboxDomain,
    egressProxyIp: environment.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
    requestTimeoutMs: 30_000,
  });
  try {
    for (const sandbox of await cube.list()) {
      if (acceptanceSessions.has(sandbox.metadata["picloud.session_id"] ?? "")) {
        await cube.destroy(sandbox.sandboxId);
      }
    }
  } finally {
    await cube.close();
  }
}

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function waitForRun(runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(`Run ${runId} ended as ${run.state}: ${JSON.stringify(run.failure)}`);
    }
    await wait(100);
  }
  throw new Error(`Run ${runId} did not settle`);
}

async function runTurn(sessionId, prompt, afterSequence) {
  const accepted = await api.acceptTurn(
    sessionId,
    prompt,
    newIdempotencyKey("subagent-live"),
    "off",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
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
        if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
          terminal = event;
          controller.abort();
        }
      },
    });
    assert.equal(terminal?.type, "turn.completed", JSON.stringify(terminal?.payload));
    await waitForRun(accepted.runId);
    return { accepted, cursor, text: text.join("") };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function executionEvidence(parentRunId) {
  const value = await psql(`
    select json_build_object(
      'executionId', execution.id,
      'workspaceMode', execution.workspace_mode,
      'state', execution.state,
      'childSessionId', execution.child_session_id,
      'childRunId', execution.child_run_id,
      'parentWorkspaceId', parent_run.workspace_id,
      'childWorkspaceId', child_run.workspace_id,
      'childRunState', child_run.state,
      'parentWorker', parent_attempt.claim_owner_id,
      'childWorker', child_attempt.claim_owner_id,
      'sameWorker', parent_attempt.claim_owner_id = child_attempt.claim_owner_id,
      'inheritedReferenceCount', (
        select count(*)
        from pi_session_entry_refs ref
        where ref.tenant_id = execution.tenant_id
          and ref.session_id = execution.child_session_id::text
      ),
      'childOwnedEntryCount', (
        select count(*)
        from pi_session_entries entry
        where entry.tenant_id = execution.tenant_id
          and entry.session_id = execution.child_session_id::text
      ),
      'workspaceKind', child_workspace.workspace_kind,
      'workspaceDeleted', child_workspace.deleted_at is not null,
      'patchContainsIsolatedFile', exists (
        select 1
        from workspace_versions as version
        join artifacts as artifact on artifact.id = version.patch_artifact_id
        join checkpoint_objects as object on object.object_key = artifact.object_key
        where version.run_id = child_run.id
          and position('isolated-child-only.txt' in convert_from(object.bytes, 'UTF8')) > 0
      )
    )::text
    from subagent_executions as execution
    join runs as parent_run on parent_run.id = execution.parent_run_id
    join run_attempts as parent_attempt on parent_attempt.id = parent_run.current_attempt_id
    join runs as child_run on child_run.id = execution.child_run_id
    join run_attempts as child_attempt on child_attempt.id = child_run.current_attempt_id
    join workspaces as child_workspace on child_workspace.id = child_run.workspace_id
    where execution.parent_run_id = ${sqlLiteral(parentRunId)}
    order by execution.created_at desc
    limit 1
  `);
  assert(value, `Parent Run ${parentRunId} produced no durable Subagent execution`);
  return JSON.parse(value);
}

async function recursiveTreeEvidence(rootRunId) {
  const value = await psql(`
    select coalesce(json_agg(json_build_object(
      'executionId', execution.id,
      'parentExecutionId', execution.parent_execution_id,
      'rootSessionId', execution.root_session_id,
      'rootRunId', execution.root_run_id,
      'depth', execution.depth,
      'state', execution.state,
      'childSessionId', execution.child_session_id,
      'childRunId', execution.child_run_id,
      'childRunState', child_run.state
    ) order by execution.depth, execution.created_at), '[]'::json)::text
    from subagent_executions as execution
    join runs as child_run on child_run.id = execution.child_run_id
    where execution.root_run_id = ${sqlLiteral(rootRunId)}
  `);
  return JSON.parse(value);
}

await retireHistoricalAcceptanceCubes();
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must use a real model");
const suffix = `${Date.now().toString(36)}`;
const project = await api.createProject(`Subagent production acceptance ${suffix}`);
const session = await api.createSession(
  project.projectId,
  project.workspaceId,
  `Subagent production acceptance ${suffix}`,
  "ephemeral",
);

const none = await runTurn(
  session.sessionId,
  [
    "Call the subagent Tool exactly once and do not call any file or bash Tool.",
    'Use this exact workflowScript: return runs.run("none", {agent:"oracle", task:"Reply exactly SUBAGENT-NONE-OK"})',
    "After it finishes, reply with SUBAGENT-NONE-OK.",
  ].join(" "),
  0,
);
const noneEvidence = await executionEvidence(none.accepted.runId);
assert.equal(noneEvidence.workspaceMode, "none");
assert.equal(noneEvidence.childRunState, "completed");

const shared = await runTurn(
  session.sessionId,
  [
    "First use bash to write exactly SHARED-PARENT-OK into /workspace/shared-parent-marker.txt.",
    "Then call the subagent Tool exactly once with worktree:false.",
    'Use this exact workflowScript: return runs.run("shared", {agent:"worker", task:"Use bash to read /workspace/shared-parent-marker.txt and reply exactly SHARED-CHILD-OK if it contains SHARED-PARENT-OK"})',
    "After it finishes, reply with SHARED-CHILD-OK.",
  ].join(" "),
  none.cursor,
);
const sharedEvidence = await executionEvidence(shared.accepted.runId);
assert.equal(sharedEvidence.workspaceMode, "shared_serialized");
assert.equal(sharedEvidence.childWorkspaceId, sharedEvidence.parentWorkspaceId);
assert.equal(sharedEvidence.childRunState, "completed");
assert(sharedEvidence.inheritedReferenceCount > 0);

const isolated = await runTurn(
  session.sessionId,
  [
    "Call the subagent Tool exactly once with worktree:true.",
    'Use this exact workflowScript: return runs.run("isolated", {agent:"worker", task:"Use bash to create /workspace/isolated-child-only.txt containing ISOLATED-CHILD-OK, read it back, and reply exactly ISOLATED-CHILD-OK"})',
    "Do not create isolated-child-only.txt yourself. After the child finishes, reply with ISOLATED-CHILD-OK.",
  ].join(" "),
  shared.cursor,
);
const isolatedEvidence = await executionEvidence(isolated.accepted.runId);
assert.equal(isolatedEvidence.workspaceMode, "isolated");
assert.notEqual(isolatedEvidence.childWorkspaceId, isolatedEvidence.parentWorkspaceId);
assert.equal(isolatedEvidence.workspaceKind, "subagent_isolated");
assert.equal(isolatedEvidence.workspaceDeleted, true);
assert.equal(isolatedEvidence.patchContainsIsolatedFile, true);
assert(isolatedEvidence.inheritedReferenceCount > 0);

const nestedTask = [
  "Call the subagent Tool exactly once and do not call file or bash Tools.",
  'Use this exact workflowScript: return runs.run("nested", {agent:"oracle", task:"Reply exactly SUBAGENT-NESTED-LEAF-OK"})',
  "After it finishes, reply exactly SUBAGENT-NESTED-PARENT-OK.",
].join(" ");
const recursive = await runTurn(
  session.sessionId,
  [
    "Create a two-level recursive Agent tree.",
    `Call the subagent Tool exactly once with this exact workflowScript: return runs.run("recursive-parent", {agent:"worker", task:${JSON.stringify(nestedTask)}})`,
    "After it finishes, reply exactly SUBAGENT-RECURSIVE-OK.",
  ].join(" "),
  isolated.cursor,
);
const recursiveEvidence = await recursiveTreeEvidence(recursive.accepted.runId);
assert.equal(recursiveEvidence.length, 2, JSON.stringify(recursiveEvidence));
assert.deepEqual(
  recursiveEvidence.map((execution) => execution.depth),
  [1, 2],
);
assert(recursiveEvidence.every((execution) => execution.rootRunId === recursive.accepted.runId));
assert(recursiveEvidence.every((execution) => execution.childRunState === "completed"));
assert.equal(recursiveEvidence[0].parentExecutionId, null);
assert.equal(recursiveEvidence[1].parentExecutionId, recursiveEvidence[0].executionId);

const tenantId = await psql(
  `select tenant_id::text from sessions where id = ${sqlLiteral(session.sessionId)}`,
);
const volumeId = workspaceVolumeId({ tenantId, workspaceId: session.workspaceId });
const possibleParentFile = resolve(
  runtimeDirectory,
  "state/cube-shared/volume",
  `picloud-posix-${volumeId}`,
  "workspace/isolated-child-only.txt",
);
await assert.rejects(access(possibleParentFile), (error) => error?.code === "ENOENT");

const report = {
  accepted: true,
  checkedAt: new Date().toISOString(),
  model: { provider: model.provider, modelId: model.modelId },
  parentSessionId: session.sessionId,
  modes: { none: noneEvidence, shared: sharedEvidence, isolated: isolatedEvidence },
  recursiveTree: recursiveEvidence,
};
await mkdir(resolve(repositoryRoot, "docs/reports"), { recursive: true });
await writeFile(
  resolve(repositoryRoot, "docs/reports/subagent-production-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
