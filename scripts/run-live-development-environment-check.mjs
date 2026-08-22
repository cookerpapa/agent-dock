import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { OfficialCubeSandboxRuntimeClient } from "../packages/tool-broker/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_DEVELOPMENT_ENVIRONMENT_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_DEVELOPMENT_ENVIRONMENT_CHECK=1 to acknowledge real Cube/model usage",
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

const databaseUrl = new URL(
  (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/database-url"),
      4_096,
      "Production database URL",
    )
  ).trim(),
);
const databaseUser = decodeURIComponent(databaseUrl.username);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));

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

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function waitForRun(runId) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(`Run ${runId} ended as ${run.state}: ${JSON.stringify(run.failure)}`);
    }
    await wait(100);
  }
  throw new Error(`Run ${runId} did not settle`);
}

async function terminalCommand(path, command, marker) {
  const target = new URL(path, baseUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(target, { headers: { authorization: `Bearer ${token}` } });
  let output = "";
  let ready = false;
  let finished = false;
  let closing = false;
  const deadline = Date.now() + 120_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setInterval(() => {
      if (Date.now() < deadline) return;
      clearInterval(timeout);
      socket.terminate();
      rejectPromise(new Error(`Terminal did not produce ${marker}: ${output.slice(-2_000)}`));
    }, 250);
    const finish = () => {
      if (finished || closing) return;
      closing = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.close",
          }),
        );
      }
    };
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "workspace_terminal.ready" && !ready) {
        ready = true;
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.input",
            data: Buffer.from(`${command}\n`, "utf8").toString("base64"),
          }),
        );
      } else if (frame.type === "workspace_terminal.output") {
        output += Buffer.from(frame.data, "base64").toString("utf8");
        if (output.includes(marker)) finish();
      } else if (frame.type === "workspace_terminal.error") {
        clearInterval(timeout);
        rejectPromise(new Error(`${frame.code}: ${frame.message}`));
      }
    });
    socket.once("error", (error) => {
      clearInterval(timeout);
      rejectPromise(error);
    });
    socket.once("close", () => {
      if (!closing || finished) return;
      finished = true;
      clearInterval(timeout);
      resolvePromise(output);
    });
  });
}

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
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${String(cluster.api.port)}`,
  apiKey: cubeApiKey,
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: environment.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
  requestTimeoutMs: 60_000,
});

const suffix = Date.now().toString(36);
const project = await api.createProject(`Exclusive environment acceptance ${suffix}`);
const development = await api.createDevelopmentEnvironment(
  project.workspaceId,
  "standard",
  newIdempotencyKey("environment"),
);
assert.equal(development.state, "running");
const runtimeName = await psql(
  `select runtime_name from development_environments where id = ${sqlLiteral(development.environmentId)}`,
);
assert(runtimeName, "Development environment did not persist its Cube identity");
await terminalCommand(
  `/v1/development-environments/${development.environmentId}/terminal`,
  "printf 'EXCLUSIVE_FILE_OK\\n' > /workspace/exclusive.txt; printf '<!doctype html><html><head><title>PiCloud Preview</title></head><body>PI_CLOUD_PREVIEW_OK</body></html>\\n' > /workspace/index.html; setsid sh -c 'while true; do date +%s > /workspace/heartbeat; sleep 1; done' </dev/null >/tmp/exclusive-loop.log 2>&1 & echo $! > /workspace/exclusive.pid; setsid python3 -m http.server 8000 --bind 0.0.0.0 --directory /workspace </dev/null >/tmp/preview.log 2>&1 & echo EXCLUSIVE_FIRST_OK",
  "EXCLUSIVE_FIRST_OK",
);
await wait(2_000);
const preview = await fetch(
  new URL(`/v1/development-environments/${development.environmentId}/preview/8000/`, baseUrl),
  { headers: { authorization: `Bearer ${token}`, accept: "text/html" } },
);
assert.equal(preview.status, 200);
assert.match(await preview.text(), /PI_CLOUD_PREVIEW_OK/);
await terminalCommand(
  `/v1/development-environments/${development.environmentId}/terminal`,
  'test "$(cat /workspace/exclusive.txt)" = EXCLUSIVE_FILE_OK && kill -0 "$(cat /workspace/exclusive.pid)" && echo EXCLUSIVE_RECONNECT_OK',
  "EXCLUSIVE_RECONNECT_OK",
);

const session = await api.createSession(
  project.projectId,
  project.workspaceId,
  `Queued behind exclusive environment ${suffix}`,
  "ephemeral",
);
const queued = await api.acceptTurn(
  session.sessionId,
  "Reply exactly EXCLUSIVE_QUEUE_RELEASED_OK without using tools.",
  newIdempotencyKey("turn"),
  "off",
);
await wait(2_000);
assert.equal((await api.getRun(queued.runId)).state, "queued");

const paused = await api.developmentEnvironmentAction(
  development.environmentId,
  "pause",
  newIdempotencyKey("environment"),
);
assert.equal(paused.state, "paused");
assert.equal((await cube.read(runtimeName))?.state, "paused");
const resumed = await api.developmentEnvironmentAction(
  development.environmentId,
  "resume",
  newIdempotencyKey("environment"),
);
assert.equal(resumed.state, "running");
assert.equal(
  await psql(
    `select runtime_name from development_environments where id = ${sqlLiteral(development.environmentId)}`,
  ),
  runtimeName,
);
await terminalCommand(
  `/v1/development-environments/${development.environmentId}/terminal`,
  'kill -0 "$(cat /workspace/exclusive.pid)" && echo EXCLUSIVE_RESUME_OK',
  "EXCLUSIVE_RESUME_OK",
);

const released = await api.developmentEnvironmentAction(
  development.environmentId,
  "release",
  newIdempotencyKey("environment"),
);
assert.equal(released.state, "released");
assert.equal(await cube.read(runtimeName), undefined);
await waitForRun(queued.runId);
await terminalCommand(
  `/v1/conversations/${session.sessionId}/terminal`,
  'test "$(cat /workspace/exclusive.txt)" = EXCLUSIVE_FILE_OK && echo EXCLUSIVE_VOLUME_OK',
  "EXCLUSIVE_VOLUME_OK",
);

const report = {
  accepted: true,
  checkedAt: new Date().toISOString(),
  developmentEnvironmentId: development.environmentId,
  workspaceId: project.workspaceId,
  cubeIdentityStableAcrossPause: true,
  processSurvivedTerminalReconnect: true,
  processSurvivedPauseResume: true,
  agentRunQueuedUntilRelease: true,
  workspaceVolumeSurvivedRelease: true,
  authenticatedHttpPreviewPassed: true,
  selectedProfile: development.profileKey,
};
await cube.close();
await mkdir(resolve(repositoryRoot, "docs/reports"), { recursive: true });
await writeFile(
  resolve(repositoryRoot, "docs/reports/development-environment-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
