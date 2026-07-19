import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = resolve(repositoryRoot, "deploy/production/compose.yaml");
const suffix = randomBytes(5).toString("hex");
const projectName = `agent-dock-check-${suffix}`;
const supervisorId = `agent-dock-check-supervisor-${suffix}`;
const runtimeDirectory = await mkdtemp(join(tmpdir(), `agent-dock-production-${suffix}-`));
const environmentFile = resolve(runtimeDirectory, ".env");
const httpPort = await availablePort();
const baseUrl = `http://127.0.0.1:${String(httpPort)}`;
const keepDeployment = process.env.AGENT_DOCK_PRODUCTION_CHECK_KEEP === "1";
const skipBuild = process.env.AGENT_DOCK_PRODUCTION_CHECK_SKIP_BUILD === "1";
const processEnvironment = {
  ...process.env,
  AGENT_DOCK_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENT_DOCK_HTTP_BIND_ADDRESS: "127.0.0.1",
  AGENT_DOCK_HTTP_PORT: String(httpPort),
  AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED: "true",
  AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS: "3",
  AGENT_DOCK_SUPERVISOR_ID: supervisorId,
  COMPOSE_PROJECT_NAME: projectName,
};
let initialized = false;
let apiToken = "";

function report(stage, details = {}) {
  process.stdout.write(`${JSON.stringify({ stage, ...details })}\n`);
}

function commandFailure(command, args, error, stderr) {
  const suffixText = stderr.trim().length === 0 ? "" : `: ${stderr.trim().slice(-2_000)}`;
  return new Error(`${command} ${args.join(" ")} failed (${error.message})${suffixText}`);
}

function capture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: options.environment ?? processEnvironment,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 8 * 1_024 * 1_024,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(commandFailure(command, args, error, stderr));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.environment ?? processEnvironment,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", () => rejectPromise(new Error(`${command} could not start`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
  });
}

function composeArguments(args) {
  return [
    "compose",
    "--project-name",
    projectName,
    "--env-file",
    environmentFile,
    "--file",
    composeFile,
    ...args,
  ];
}

function composeCapture(args, timeoutMs = 120_000) {
  return capture("docker", composeArguments(args), { timeoutMs });
}

function composeRun(args) {
  return run("docker", composeArguments(args));
}

async function tenantAdmin(args) {
  const output = await composeCapture(
    [
      "run",
      "--rm",
      "--no-deps",
      "database-bootstrap",
      "/app/packages/control-plane/src/tenant-admin.ts",
      ...args,
    ],
    120_000,
  );
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.operation === "string") return parsed;
    } catch {
      // Docker Compose may print non-JSON lifecycle lines around the one-time result.
    }
  }
  throw new Error("Tenant administration did not return its bounded JSON result");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  return address.port;
}

async function waitFor(predicate, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `${description} did not become true within ${String(timeoutMs)} ms${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

async function serviceContainerIds(service) {
  const output = await composeCapture(["ps", "--quiet", service]);
  return output.length === 0 ? [] : output.split(/\r?\n/).filter(Boolean);
}

async function waitForHealthyService(service, expectedCount = 1, timeoutMs = 90_000) {
  return waitFor(
    async () => {
      const ids = await serviceContainerIds(service);
      if (ids.length !== expectedCount) return false;
      const statuses = await Promise.all(
        ids.map((id) => capture("docker", ["inspect", "--format", "{{.State.Health.Status}}", id])),
      );
      return statuses.every((status) => status === "healthy") ? ids : false;
    },
    `${service} health (${String(expectedCount)} replicas)`,
    timeoutMs,
  );
}

async function http(path, options = {}, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, text);
  let body;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body, text };
}

function authenticatedHeaders(extra = {}, token = apiToken) {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function postAs(token, path, body, expectedStatus, idempotencyKey) {
  return http(
    path,
    {
      method: "POST",
      headers: authenticatedHeaders(
        {
          "content-type": "application/json",
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        },
        token,
      ),
      body: JSON.stringify(body),
    },
    expectedStatus,
  );
}

async function post(path, body, expectedStatus, idempotencyKey) {
  return postAs(apiToken, path, body, expectedStatus, idempotencyKey);
}

async function registerTenant(tenantSlug, displayName, expectedStatus) {
  return http(
    "/v1/registrations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantSlug, displayName }),
    },
    expectedStatus,
  );
}

function parseSseFrame(raw) {
  const data = [];
  let id;
  let eventName;
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    if (field === "id") id = value;
    if (field === "event") eventName = value;
  }
  if (data.length === 0) return undefined;
  return { id, eventName, value: JSON.parse(data.join("\n")) };
}

async function readSessionEventsUntil(
  sessionId,
  afterSequence,
  predicate,
  timeoutMs = 120_000,
  token = apiToken,
) {
  const deadline = Date.now() + timeoutMs;
  const events = [];
  let cursor = afterSequence;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      const response = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          headers: authenticatedHeaders(
            {
              accept: "text/event-stream",
              "last-event-id": String(cursor),
            },
            token,
          ),
          signal: controller.signal,
        },
      );
      if (!response.ok || response.body === null) {
        if (response.status >= 500) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
          continue;
        }
        throw new Error(`SSE request failed with HTTP ${String(response.status)}`);
      }
      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/i);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = /\r?\n\r?\n/.exec(buffer);
        while (boundary !== null) {
          const raw = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const frame = parseSseFrame(raw);
          boundary = /\r?\n\r?\n/.exec(buffer);
          if (frame === undefined) continue;
          assert.match(frame.id ?? "", /^[1-9]\d*$/);
          assert.equal(frame.eventName, frame.value.type);
          assert.equal(frame.value.sessionId, sessionId);
          assert.equal(Number(frame.id), frame.value.seq);
          assert.equal(frame.value.seq, cursor + 1);
          cursor = frame.value.seq;
          events.push(frame.value);
          if (predicate(frame.value, events)) {
            await reader.cancel().catch(() => undefined);
            return { events, cursor };
          }
        }
      }
    } catch (error) {
      if (Date.now() >= deadline) break;
      if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  throw new Error(`Session ${sessionId} did not produce the requested durable event`);
}

function isTerminalFor(turnId) {
  return (event) =>
    event.turnId === turnId &&
    (event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled");
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function psql(query) {
  return composeCapture(
    [
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
    ],
    30_000,
  );
}

async function latestBoot() {
  const row = await psql(
    `select id::text || '|' || boot_id::text || '|' || state from sandboxes where supervisor_id = ${sqlLiteral(
      supervisorId,
    )} order by created_at desc limit 1`,
  );
  const [sandboxId, bootId, state] = row.split("|");
  assert.match(sandboxId, /^[0-9a-f-]{36}$/i);
  assert.match(bootId, /^[0-9a-f-]{36}$/i);
  return { sandboxId, bootId, state };
}

async function waitForLatestBootDifferent(previous) {
  return waitFor(async () => {
    const current = await latestBoot();
    return current.bootId !== previous.bootId && current.state === "ready" ? current : false;
  }, "fresh Supervisor boot");
}

async function assertCheckpointObjects(sessionId, expectedCount, tenantId) {
  const output = await psql(
    `select kind || '|' || object_key from artifacts where session_id = ${sqlLiteral(
      sessionId,
    )} order by created_at, id`,
  );
  const rows = output.length === 0 ? [] : output.split(/\r?\n/);
  assert.equal(rows.length, expectedCount);
  for (const row of rows) {
    const separator = row.indexOf("|");
    const kind = row.slice(0, separator);
    const objectKey = row.slice(separator + 1);
    assert(["pi_session_snapshot", "workspace_snapshot"].includes(kind));
    assert.match(objectKey, /^[a-zA-Z0-9/_.-]+$/);
    if (tenantId !== undefined) {
      assert.equal(objectKey.startsWith(`checkpoints/${tenantId}/${sessionId}/`), true);
    }
    await composeCapture([
      "exec",
      "-T",
      "minio",
      "/bin/sh",
      "-eu",
      "-c",
      'export MC_HOST_agentdock="http://$(cat /run/agent-dock-secrets/minio-root-user):$(cat /run/agent-dock-secrets/minio-root-password)@127.0.0.1:9000"; mc stat "agentdock/$1" >/dev/null',
      "agent-dock-object-stat",
      `agent-dock-checkpoints/production/v1/${objectKey}`,
    ]);
  }
}

async function assertCursor(sessionId, expected) {
  const row = await psql(
    `select last_persisted_seq::text || '|' || acknowledged_through_seq::text from session_event_cursors where session_id = ${sqlLiteral(
      sessionId,
    )}`,
  );
  assert.equal(row, `${String(expected)}|${String(expected)}`);
  assert.equal(
    await psql(`select count(*) from session_leases where session_id = ${sqlLiteral(sessionId)}`),
    "0",
  );
}

async function managedWorkerIds(filters = []) {
  const args = [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    "label=agent-dock.managed=true",
    "--filter",
    `label=agent-dock.supervisor-id=${supervisorId}`,
  ];
  for (const filter of filters) args.push("--filter", filter);
  const output = await capture("docker", args);
  return output.length === 0 ? [] : output.split(/\r?\n/).filter(Boolean);
}

async function waitForWorker(commandId) {
  return waitFor(
    async () => {
      const ids = await managedWorkerIds([`label=agent-dock.command-id=${commandId}`]);
      return ids.length === 1 ? ids[0] : false;
    },
    `managed worker for command ${commandId}`,
    30_000,
  );
}

async function assertWorkerSecurity(containerId, secretValues) {
  const inspected = JSON.parse(await capture("docker", ["inspect", containerId]))[0];
  assert.equal(inspected.Config.User, "1000:1000");
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert(inspected.HostConfig.CapDrop.includes("ALL"));
  assert.equal(inspected.HostConfig.SecurityOpt.includes("no-new-privileges:true"), true);
  assert.equal(
    inspected.Mounts.some((mount) => mount.Type === "bind"),
    false,
  );
  assert.equal(inspected.HostConfig.Binds?.length ?? 0, 0);
  const serialized = JSON.stringify({
    environment: inspected.Config.Env,
    command: inspected.Config.Cmd,
    entrypoint: inspected.Config.Entrypoint,
    mounts: inspected.Mounts,
  });
  for (const secret of secretValues) assert.equal(serialized.includes(secret), false);
}

async function containerStartedAt(containerId) {
  return capture("docker", ["inspect", "--format", "{{.State.StartedAt}}", containerId]);
}

async function assertOnlyWebPublished() {
  const output = await capture("docker", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]);
  const ids = output.split(/\r?\n/).filter(Boolean);
  assert(ids.length >= 6);
  for (const id of ids) {
    const inspected = JSON.parse(await capture("docker", ["inspect", id]))[0];
    const service = inspected.Config.Labels["com.docker.compose.service"];
    const bindings = inspected.HostConfig.PortBindings ?? {};
    if (service !== "web") {
      assert.deepEqual(bindings, {}, `${service} unexpectedly publishes a host port`);
      continue;
    }
    assert.deepEqual(Object.keys(bindings), ["8080/tcp"]);
    assert.equal(bindings["8080/tcp"].length, 1);
    assert.equal(bindings["8080/tcp"][0].HostIp, "127.0.0.1");
    assert.equal(bindings["8080/tcp"][0].HostPort, String(httpPort));
  }
}

async function assertTenantNeutralControlPlaneRuntime() {
  const ids = await serviceContainerIds("control-plane");
  assert(ids.length >= 1);
  for (const id of ids) {
    const inspected = JSON.parse(await capture("docker", ["inspect", id]))[0];
    const environment = inspected.Config.Env ?? [];
    for (const prefix of [
      "AGENT_DOCK_API_TOKEN=",
      "AGENT_DOCK_API_TOKEN_FILE=",
      "AGENT_DOCK_TENANT_ID=",
      "AGENT_DOCK_USER_ID=",
      "AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID=",
      "AGENT_DOCK_CREDENTIAL_BINDING_ID=",
    ]) {
      assert.equal(
        environment.some((value) => value.startsWith(prefix)),
        false,
      );
    }
    assert.equal(
      inspected.Mounts.some((mount) => mount.Destination === "/run/agent-dock-secrets/api-token"),
      false,
    );
  }
}

async function assertApplicationIdentity() {
  const applicationSecret = await stat(resolve(runtimeDirectory, "secrets/api-token"));
  assert.notEqual(applicationSecret.uid, 0);
  const expected = `${String(applicationSecret.uid)}:${String(applicationSecret.gid)}`;
  for (const service of ["database-bootstrap", "control-plane"]) {
    const output = await composeCapture(["ps", "--all", "--quiet", service]);
    const ids = output.split(/\r?\n/).filter(Boolean);
    assert(ids.length >= 1);
    for (const id of ids) {
      assert.equal(
        await capture("docker", ["inspect", "--format", "{{.Config.User}}", id]),
        expected,
      );
    }
  }
}

async function readSecretValues() {
  const names = [
    "api-token",
    "database-url",
    "minio-root-password",
    "minio-root-user",
    "model-credential-master-key",
    "postgres-password",
    "supervisor-enrollment-token",
    "supervisor-management-token",
  ];
  const values = await Promise.all(
    names.map(async (name) =>
      (await readFile(resolve(runtimeDirectory, "secrets", name), "utf8")).trim(),
    ),
  );
  const awsCredentials = await readFile(
    resolve(runtimeDirectory, "secrets/aws-credentials"),
    "utf8",
  );
  const match =
    /^\[default\]\naws_access_key_id = ([A-Za-z0-9][A-Za-z0-9_-]{15,63})\naws_secret_access_key = ([A-Za-z0-9_-]{43,128})\n?$/.exec(
      awsCredentials,
    );
  assert.notEqual(match, null);
  const applicationAccessKey = match[1];
  const applicationSecretKey = match[2];
  assert.notEqual(applicationAccessKey, values[names.indexOf("minio-root-user")]);
  assert.notEqual(applicationSecretKey, values[names.indexOf("minio-root-password")]);
  return {
    applicationAccessKey,
    secretValues: [...values, applicationAccessKey, applicationSecretKey],
  };
}

async function assertObjectStorePolicy(applicationAccessKey) {
  const output = await composeCapture([
    "exec",
    "-T",
    "minio",
    "/bin/sh",
    "-eu",
    "-c",
    'export MC_HOST_agentdock="http://$(cat /run/agent-dock-secrets/minio-root-user):$(cat /run/agent-dock-secrets/minio-root-password)@127.0.0.1:9000"; mc admin user info agentdock "$1"; mc admin policy info agentdock agent-dock-checkpoint-read-write',
    "agent-dock-policy-audit",
    applicationAccessKey,
  ]);
  assert.match(output, /agent-dock-checkpoint-read-write/);
  assert.match(output, /s3:ListBucket/);
  assert.match(output, /s3:GetObject/);
  assert.match(output, /s3:PutObject/);
  assert.equal(output.includes("s3:DeleteObject"), false);
}

async function assertPrivateRuntimeFiles() {
  for (const path of [
    runtimeDirectory,
    resolve(runtimeDirectory, "secrets"),
    environmentFile,
    ...[
      "api-token",
      "aws-credentials",
      "database-url",
      "minio-root-password",
      "minio-root-user",
      "model-credential-master-key",
      "postgres-password",
      "supervisor-enrollment-token",
      "supervisor-management-token",
    ].map((name) => resolve(runtimeDirectory, "secrets", name)),
  ]) {
    const metadata = await stat(path);
    assert.equal(metadata.mode & 0o077, 0, `${path} is group/world accessible`);
  }
}

async function assertNoSecretsInDeployment(secretValues, events) {
  const composeConfig = await composeCapture(["config"]);
  const logs = await composeCapture(["logs", "--no-color"], 60_000);
  const serializedEvents = JSON.stringify(events);
  for (const secret of secretValues) {
    assert.equal(composeConfig.includes(secret), false, "Compose config contains a secret value");
    assert.equal(logs.includes(secret), false, "Container logs contain a secret value");
    assert.equal(serializedEvents.includes(secret), false, "Durable events contain a secret value");
  }
}

async function main() {
  report("initialize", { projectName, runtimeDirectory, httpPort });
  await run(process.execPath, ["scripts/init-production.mjs", "--runtime-dir", runtimeDirectory], {
    stdio: "inherit",
  });
  initialized = true;
  await assertPrivateRuntimeFiles();
  const initializedApiToken = await readFile(
    resolve(runtimeDirectory, "secrets/api-token"),
    "utf8",
  );
  const initializedModelCredentialMasterKey = await readFile(
    resolve(runtimeDirectory, "secrets/model-credential-master-key"),
    "utf8",
  );
  const legacyRootUser = await readFile(
    resolve(runtimeDirectory, "secrets/minio-root-user"),
    "utf8",
  );
  const legacyRootPassword = await readFile(
    resolve(runtimeDirectory, "secrets/minio-root-password"),
    "utf8",
  );
  await writeFile(
    resolve(runtimeDirectory, "secrets/aws-credentials"),
    `[default]\naws_access_key_id = ${legacyRootUser.trim()}\naws_secret_access_key = ${legacyRootPassword.trim()}\n`,
    { mode: 0o600 },
  );
  await run(process.execPath, ["scripts/init-production.mjs", "--runtime-dir", runtimeDirectory], {
    stdio: "inherit",
  });
  assert.equal(
    await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8"),
    initializedApiToken,
  );
  assert.equal(
    await readFile(resolve(runtimeDirectory, "secrets/model-credential-master-key"), "utf8"),
    initializedModelCredentialMasterKey,
  );
  assert.equal(
    (await readFile(resolve(runtimeDirectory, "secrets/aws-credentials"), "utf8")).includes(
      legacyRootPassword.trim(),
    ),
    false,
  );
  await assertPrivateRuntimeFiles();
  apiToken = (await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8")).trim();
  const { applicationAccessKey, secretValues } = await readSecretValues();

  await composeCapture(["config", "--quiet"]);
  if (!skipBuild) {
    report("build_images");
    await composeRun([
      "--profile",
      "image-only",
      "build",
      "control-plane",
      "supervisor-host",
      "web",
      "sandbox-image",
    ]);
  }

  report("start_topology");
  await composeRun(["up", "--detach", "--wait"]);
  await Promise.all([
    waitForHealthyService("postgres"),
    waitForHealthyService("minio"),
    waitForHealthyService("control-plane"),
    waitForHealthyService("supervisor-host"),
    waitForHealthyService("web"),
  ]);
  report("repeat_bootstrap");
  await composeRun(["run", "--rm", "--no-deps", "minio-bootstrap"]);
  await composeRun(["run", "--rm", "--no-deps", "database-bootstrap"]);
  await assertOnlyWebPublished();
  await assertApplicationIdentity();
  await assertTenantNeutralControlPlaneRuntime();
  await assertObjectStorePolicy(applicationAccessKey);

  const health = await http("/healthz", {}, 200);
  assert.equal(health.text.trim(), "ok");
  await http("/health/ready", {}, 404);
  await http(
    "/internal/v1/supervisor/boots",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    404,
  );
  await http(
    "/v1/projects",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    401,
  );
  await http("/v1/conversations", {}, 401);
  await http(
    "/v1/projects",
    {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(48)}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "unauthorized" }),
    },
    401,
  );

  report("validate_public_registration");
  await registerTenant("INVALID SLUG", "Invalid tenant", 400);
  assert.equal(await psql("select count(*) from tenants"), "1");
  const createdTenantB = (await registerTenant(`tenant-${suffix}`, "Production Tenant B", 201))
    .body;
  assert.equal(Object.hasOwn(createdTenantB, "secretSha256"), false);
  const tenantBToken = createdTenantB.apiToken;
  const tenantBId = createdTenantB.tenantId;
  assert.match(tenantBToken, /^adk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43,}$/i);
  assert.match(tenantBId, /^[0-9a-f-]{36}$/i);
  secretValues.push(tenantBToken);
  await registerTenant(`tenant-${suffix}`, "Duplicate tenant", 409);

  const capacityAttempts = await Promise.all([
    registerTenant(`capacity-a-${suffix}`, "Capacity Tenant A"),
    registerTenant(`capacity-b-${suffix}`, "Capacity Tenant B"),
  ]);
  assert.deepEqual(
    capacityAttempts.map(({ response }) => response.status).sort((left, right) => left - right),
    [201, 429],
  );
  const capacityTenant = capacityAttempts.find(({ response }) => response.status === 201)?.body;
  assert.equal(typeof capacityTenant?.apiToken, "string");
  secretValues.push(capacityTenant.apiToken);
  assert.equal(await psql("select count(*) from tenants"), "3");

  const issuedViewerB = await tenantAdmin([
    "issue",
    "--tenant",
    tenantBId,
    "--user-id",
    createdTenantB.userId,
    "--label",
    "production viewer",
    "--role",
    "viewer",
  ]);
  assert.equal(issuedViewerB.operation, "credential.issued");
  assert.equal(Object.hasOwn(issuedViewerB.credential, "secretSha256"), false);
  const viewerBToken = issuedViewerB.credential.token;
  secretValues.push(viewerBToken);

  const [identityA, identityB, viewerIdentityB] = await Promise.all([
    http("/v1/identity", { headers: authenticatedHeaders() }, 200),
    http("/v1/identity", { headers: authenticatedHeaders({}, tenantBToken) }, 200),
    http("/v1/identity", { headers: authenticatedHeaders({}, viewerBToken) }, 200),
  ]);
  assert.notEqual(identityA.body.tenantId, identityB.body.tenantId);
  assert.equal(identityB.body.tenantId, tenantBId);
  assert.equal(identityB.body.role, "owner");
  assert.equal(viewerIdentityB.body.role, "viewer");
  await postAs(viewerBToken, "/v1/projects", { name: "viewer denied" }, 403);

  const sharedProjectName = `Production repair ${suffix}`;
  const projectB = (await postAs(tenantBToken, "/v1/projects", { name: sharedProjectName }, 201))
    .body;
  const sessionB = (
    await postAs(
      tenantBToken,
      `/v1/projects/${projectB.projectId}/sessions`,
      { workspaceId: projectB.workspaceId },
      201,
    )
  ).body;
  const repairPrompt = "Run the tests, repair the Java bug, and verify the result.";
  const repairB = (
    await postAs(
      tenantBToken,
      `/v1/sessions/${sessionB.sessionId}/turns`,
      { prompt: repairPrompt },
      202,
      `production-tenant-b-repair-${suffix}`,
    )
  ).body;
  const tenantBStream = await readSessionEventsUntil(
    sessionB.sessionId,
    0,
    isTerminalFor(repairB.turnId),
    120_000,
    tenantBToken,
  );
  assert.equal(tenantBStream.events.at(-1).type, "turn.completed");
  await assertCursor(sessionB.sessionId, 10);
  await assertCheckpointObjects(sessionB.sessionId, 2, tenantBId);

  const [conversationListA, conversationListB, viewerConversationListB] = await Promise.all([
    http("/v1/conversations", { headers: authenticatedHeaders() }, 200),
    http("/v1/conversations", { headers: authenticatedHeaders({}, tenantBToken) }, 200),
    http("/v1/conversations", { headers: authenticatedHeaders({}, viewerBToken) }, 200),
  ]);
  assert.equal(
    conversationListA.body.conversations.some(
      (conversation) => conversation.sessionId === sessionB.sessionId,
    ),
    false,
  );
  assert.deepEqual(
    conversationListB.body.conversations.map((conversation) => conversation.sessionId),
    [sessionB.sessionId],
  );
  assert.equal(conversationListB.body.conversations[0].turnCount, 1);
  assert.deepEqual(viewerConversationListB.body, conversationListB.body);

  const [conversationB, viewerConversationB] = await Promise.all([
    http(
      `/v1/conversations/${sessionB.sessionId}`,
      { headers: authenticatedHeaders({}, tenantBToken) },
      200,
    ),
    http(
      `/v1/conversations/${sessionB.sessionId}`,
      { headers: authenticatedHeaders({}, viewerBToken) },
      200,
    ),
  ]);
  assert.equal(conversationB.body.session.sessionId, sessionB.sessionId);
  assert.equal(conversationB.body.project.name, sharedProjectName);
  assert.deepEqual(
    conversationB.body.turns.map((turn) => turn.prompt),
    [repairPrompt],
  );
  assert.deepEqual(viewerConversationB.body, conversationB.body);
  await http(`/v1/conversations/${sessionB.sessionId}`, { headers: authenticatedHeaders() }, 404);

  await postAs(
    apiToken,
    `/v1/projects/${projectB.projectId}/sessions`,
    { workspaceId: projectB.workspaceId },
    404,
  );
  await postAs(
    apiToken,
    `/v1/sessions/${sessionB.sessionId}/turns`,
    { prompt: "foreign tenant probe" },
    404,
    `foreign-turn-${suffix}`,
  );
  await postAs(
    apiToken,
    `/v1/sessions/${sessionB.sessionId}/turns/${repairB.turnId}/cancellations`,
    {},
    404,
    `foreign-cancel-${suffix}`,
  );
  await http(
    `/v1/sessions/${sessionB.sessionId}/events`,
    { headers: authenticatedHeaders({ "last-event-id": "0" }) },
    404,
  );

  const bootBeforeReconnect = await latestBoot();
  assert.equal(bootBeforeReconnect.state, "ready");
  const supervisorContainer = (await serviceContainerIds("supervisor-host"))[0];
  const supervisorStartedAt = await containerStartedAt(supervisorContainer);

  report("repair_with_control_plane_restart", { bootId: bootBeforeReconnect.bootId });
  const project = (await post("/v1/projects", { name: sharedProjectName }, 201)).body;
  const interruptedSession = (
    await post(
      `/v1/projects/${project.projectId}/sessions`,
      { workspaceId: project.workspaceId },
      201,
    )
  ).body;
  const repair = (
    await post(
      `/v1/sessions/${interruptedSession.sessionId}/turns`,
      { prompt: repairPrompt },
      202,
      `production-repair-${suffix}`,
    )
  ).body;
  const started = await readSessionEventsUntil(
    interruptedSession.sessionId,
    0,
    (event) => event.turnId === repair.turnId && event.type === "turn.started",
  );
  assert.equal(started.cursor, 1);
  const interruptedLeaseId = await psql(
    `select lease_id from session_leases where session_id = ${sqlLiteral(
      interruptedSession.sessionId,
    )}`,
  );
  assert.match(interruptedLeaseId, /^[0-9a-f-]{36}$/);
  const interruptedFence = Number(
    await psql(
      `select fencing_token from session_leases where session_id = ${sqlLiteral(
        interruptedSession.sessionId,
      )}`,
    ),
  );
  assert(Number.isSafeInteger(interruptedFence) && interruptedFence > 0);
  await composeRun(["restart", "control-plane"]);
  await waitForHealthyService("control-plane");
  await waitForHealthyService("supervisor-host");
  assert.equal(await containerStartedAt(supervisorContainer), supervisorStartedAt);
  const bootAfterReconnect = await latestBoot();
  assert.equal(bootAfterReconnect.bootId, bootBeforeReconnect.bootId);
  await waitFor(
    async () =>
      Number(
        await psql(
          `select count(*) from supervisor_connections where sandbox_id = ${sqlLiteral(
            bootBeforeReconnect.sandboxId,
          )} and state = 'superseded' and close_reason = 'reconnected'`,
        ),
      ) >= 1,
    "same-boot Supervisor reconnect",
  );
  await waitFor(
    async () =>
      (await psql(`select state from turns where id = ${sqlLiteral(repair.turnId)}`)) === "failed",
    "interrupted committed turn failure",
  );
  assert.equal(
    await psql(`select failure_code from turns where id = ${sqlLiteral(repair.turnId)}`),
    "connection_closed",
  );
  assert.equal(
    await psql(`select state from sessions where id = ${sqlLiteral(interruptedSession.sessionId)}`),
    "failed",
  );
  assert.equal(
    await psql(
      `select count(*) from session_leases where session_id = ${sqlLiteral(
        interruptedSession.sessionId,
      )}`,
    ),
    "0",
  );
  assert.equal(
    await psql(
      `select count(*) from commands where id = ${sqlLiteral(
        repair.commandId,
      )} and state = 'failed'`,
    ),
    "1",
  );

  const quarantineRoot = `/var/lib/agent-dock/spool-volume/state/quarantine/${bootBeforeReconnect.bootId}`;
  const rejectionPath = await waitFor(async () => {
    try {
      const value = await capture("docker", [
        "exec",
        supervisorContainer,
        "find",
        quarantineRoot,
        "-type",
        "f",
        "-name",
        "rejection.json",
      ]);
      const paths = value.split(/\r?\n/).filter(Boolean);
      return paths.length === 1 ? paths[0] : false;
    } catch {
      return false;
    }
  }, "permanently stale event spool quarantine");
  assert.match(
    rejectionPath,
    new RegExp(
      `^${quarantineRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{64}/rejection\\.json$`,
    ),
  );
  const rejectionEnvelope = JSON.parse(
    await capture("docker", ["exec", supervisorContainer, "cat", rejectionPath]),
  );
  assert.equal(rejectionEnvelope.format, "agent-dock.event-spool-rejection.v1");
  assert.equal(
    rejectionEnvelope.sha256,
    createHash("sha256").update(JSON.stringify(rejectionEnvelope.rejection)).digest("hex"),
  );
  assert.deepEqual(
    {
      sessionId: rejectionEnvelope.rejection.sessionId,
      leaseId: rejectionEnvelope.rejection.leaseId,
      fencingToken: rejectionEnvelope.rejection.fencingToken,
      code: rejectionEnvelope.rejection.code,
    },
    {
      sessionId: interruptedSession.sessionId,
      leaseId: interruptedLeaseId,
      fencingToken: interruptedFence,
      code: "stale_fence",
    },
  );
  assert.equal(
    String(rejectionEnvelope.rejection.rejectedSeq),
    await psql(
      `select next_event_seq from sessions where id = ${sqlLiteral(interruptedSession.sessionId)}`,
    ),
  );
  const quarantinedAssignmentDirectory = rejectionPath
    .slice(`${quarantineRoot}/`.length)
    .split("/")[0];
  assert.match(quarantinedAssignmentDirectory, /^[0-9a-f]{64}$/);
  await capture("docker", [
    "exec",
    supervisorContainer,
    "test",
    "!",
    "-e",
    `/var/lib/agent-dock/spool-volume/state/active/${bootBeforeReconnect.bootId}/${quarantinedAssignmentDirectory}`,
  ]);

  report("repair_after_same_boot_reconnect", { bootId: bootAfterReconnect.bootId });
  const session = (
    await post(
      `/v1/projects/${project.projectId}/sessions`,
      { workspaceId: project.workspaceId },
      201,
    )
  ).body;
  const recoveredRepair = (
    await post(
      `/v1/sessions/${session.sessionId}/turns`,
      { prompt: repairPrompt },
      202,
      `production-recovered-repair-${suffix}`,
    )
  ).body;
  const repairStream = await readSessionEventsUntil(
    session.sessionId,
    0,
    isTerminalFor(recoveredRepair.turnId),
  );
  const repairEvents = repairStream.events;
  assert.equal(repairEvents.at(-1).type, "turn.completed");
  assert.deepEqual(
    repairEvents.map((event) => event.type),
    [
      "turn.started",
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "assistant.text.delta",
      "assistant.text.delta",
      "turn.completed",
    ],
  );
  assert.match(repairEvents.at(-1).payload.workspacePatch.patch, /return left \+ right/);
  assert.equal(JSON.stringify(repairEvents).includes(repairPrompt), false);
  await assertCursor(session.sessionId, 10);
  await assertCheckpointObjects(session.sessionId, 2);

  report("scale_control_plane", { replicas: 2 });
  await composeRun([
    "up",
    "--detach",
    "--no-recreate",
    "--scale",
    "control-plane=2",
    "control-plane",
  ]);
  await waitForHealthyService("control-plane", 2);
  await assertTenantNeutralControlPlaneRuntime();
  const followUp = (
    await post(
      `/v1/sessions/${session.sessionId}/turns`,
      { prompt: "Verify the previous repair after a cold activation." },
      202,
      `production-followup-${suffix}`,
    )
  ).body;
  const followUpStream = await readSessionEventsUntil(
    session.sessionId,
    10,
    isTerminalFor(followUp.turnId),
  );
  assert.equal(followUpStream.cursor, 16);
  assert.equal(followUpStream.events.at(-1).type, "turn.completed");
  assert.match(
    followUpStream.events
      .filter((event) => event.type === "assistant.text.delta")
      .map((event) => event.payload.text)
      .join(""),
    /Prior conversation and Java repair restored/,
  );
  await assertCursor(session.sessionId, 16);
  await assertCheckpointObjects(session.sessionId, 4);

  report("scale_control_plane", { replicas: 1 });
  await composeRun([
    "up",
    "--detach",
    "--no-recreate",
    "--scale",
    "control-plane=1",
    "control-plane",
  ]);
  await waitForHealthyService("control-plane", 1);
  await assertTenantNeutralControlPlaneRuntime();
  await waitForHealthyService("supervisor-host");
  assert.equal((await latestBoot()).bootId, bootBeforeReconnect.bootId);

  report("restart_supervisor_host");
  await composeRun(["restart", "supervisor-host"]);
  await waitForHealthyService("supervisor-host");
  const freshBoot = await waitForLatestBootDifferent(bootBeforeReconnect);
  await waitFor(
    async () =>
      (await psql(
        `select coalesce((select state from sandbox_retirements where sandbox_id = ${sqlLiteral(
          bootBeforeReconnect.sandboxId,
        )}), '')`,
      )) === "completed",
    "old Supervisor retirement",
  );
  assert.equal(
    await psql(
      `select state from sandboxes where id = ${sqlLiteral(bootBeforeReconnect.sandboxId)}`,
    ),
    "terminated",
  );
  assert.equal(
    await psql(
      `select count(*) from supervisor_boot_credentials where sandbox_id = ${sqlLiteral(
        bootBeforeReconnect.sandboxId,
      )} and revoked_at is not null`,
    ),
    "1",
  );
  const postRestart = (
    await post(
      `/v1/sessions/${session.sessionId}/turns`,
      { prompt: "Recheck the restored repair after a fresh Supervisor boot." },
      202,
      `production-post-restart-${suffix}`,
    )
  ).body;
  const postRestartStream = await readSessionEventsUntil(
    session.sessionId,
    16,
    isTerminalFor(postRestart.turnId),
  );
  assert.equal(postRestartStream.cursor, 22);
  assert.equal(postRestartStream.events.at(-1).type, "turn.completed");
  await assertCursor(session.sessionId, 22);
  await assertCheckpointObjects(session.sessionId, 6);

  report("cancel_active_worker", { bootId: freshBoot.bootId });
  const cancellationProject = (
    await post("/v1/projects", { name: `Production cancellation ${suffix}` }, 201)
  ).body;
  const cancellationSession = (
    await post(
      `/v1/projects/${cancellationProject.projectId}/sessions`,
      { workspaceId: cancellationProject.workspaceId },
      201,
    )
  ).body;
  const cancellationTurn = (
    await post(
      `/v1/sessions/${cancellationSession.sessionId}/turns`,
      { prompt: "agent-dock://acceptance/cancellation-hold" },
      202,
      `production-cancellation-turn-${suffix}`,
    )
  ).body;
  const cancellationStarted = await readSessionEventsUntil(
    cancellationSession.sessionId,
    0,
    (event) => event.turnId === cancellationTurn.turnId && event.type === "turn.started",
  );
  const workerId = await waitForWorker(cancellationTurn.commandId);
  await assertWorkerSecurity(workerId, secretValues);
  await post(
    `/v1/sessions/${cancellationSession.sessionId}/turns/${cancellationTurn.turnId}/cancellations`,
    { gracePeriodMs: 2_000 },
    202,
    `production-cancel-${suffix}`,
  );
  const cancellationTerminal = await readSessionEventsUntil(
    cancellationSession.sessionId,
    cancellationStarted.cursor,
    isTerminalFor(cancellationTurn.turnId),
  );
  assert.equal(cancellationTerminal.events.at(-1).type, "turn.cancelled");
  await waitFor(
    async () =>
      (await managedWorkerIds([`label=agent-dock.command-id=${cancellationTurn.commandId}`]))
        .length === 0,
    "cancelled worker removal",
  );
  assert.equal(
    await psql(
      `select count(*) from session_leases where session_id = ${sqlLiteral(
        cancellationSession.sessionId,
      )}`,
    ),
    "0",
  );
  await waitFor(async () => (await managedWorkerIds()).length === 0, "all worker removal");

  const replay = await readSessionEventsUntil(session.sessionId, 0, (event) => event.seq === 22);
  assert.equal(replay.events.length, 22);
  assert.deepEqual(
    replay.events.map((event) => event.seq),
    Array.from({ length: 22 }, (_, index) => index + 1),
  );

  const identityBAfterRestarts = await http(
    "/v1/identity",
    { headers: authenticatedHeaders({}, tenantBToken) },
    200,
  );
  assert.equal(identityBAfterRestarts.body.tenantId, tenantBId);
  const tenantBReplay = await readSessionEventsUntil(
    sessionB.sessionId,
    0,
    (event) => event.seq === 10,
    120_000,
    tenantBToken,
  );
  assert.equal(tenantBReplay.events.length, 10);
  await assertCheckpointObjects(sessionB.sessionId, 2, tenantBId);
  assert.equal(
    await psql(
      `select count(distinct tenant_id) from sessions where id in (${sqlLiteral(
        session.sessionId,
      )}, ${sqlLiteral(sessionB.sessionId)})`,
    ),
    "2",
  );

  const [finalConversationListA, finalConversationListB] = await Promise.all([
    http("/v1/conversations", { headers: authenticatedHeaders() }, 200),
    http("/v1/conversations", { headers: authenticatedHeaders({}, tenantBToken) }, 200),
  ]);
  assert.equal(
    finalConversationListA.body.conversations.some(
      (conversation) => conversation.sessionId === sessionB.sessionId,
    ),
    false,
  );
  assert.equal(
    finalConversationListA.body.conversations.some(
      (conversation) => conversation.sessionId === session.sessionId,
    ),
    true,
  );
  assert.deepEqual(
    finalConversationListB.body.conversations.map((conversation) => conversation.sessionId),
    [sessionB.sessionId],
  );

  await assertNoSecretsInDeployment(secretValues, [
    ...tenantBStream.events,
    ...tenantBReplay.events,
    ...repairEvents,
    ...followUpStream.events,
    ...postRestartStream.events,
    ...cancellationStarted.events,
    ...cancellationTerminal.events,
  ]);
  await assertOnlyWebPublished();
  report("production_check_passed", {
    projectName,
    repairedSessionId: session.sessionId,
    secondTenantSessionId: sessionB.sessionId,
    oldBootId: bootBeforeReconnect.bootId,
    freshBootId: freshBoot.bootId,
    durableEvents: 22,
    registeredTenants: 3,
  });
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  if (initialized) {
    const logs = await composeCapture(["logs", "--no-color", "--tail", "120"], 60_000).catch(
      () => "",
    );
    if (logs.length > 0) process.stderr.write(`${logs}\n`);
  }
} finally {
  if (initialized && !keepDeployment) {
    await composeRun(["down", "--volumes", "--remove-orphans", "--timeout", "15"]).catch(
      () => undefined,
    );
  }
  if (!keepDeployment) await rm(runtimeDirectory, { recursive: true, force: true });
  else report("deployment_preserved", { projectName, runtimeDirectory, baseUrl });
}

if (failure !== undefined) throw failure;
