import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const allocatedPorts = new Set([httpPort]);
const prometheusPort = await distinctAvailablePort(allocatedPorts);
allocatedPorts.add(prometheusPort);
const jaegerPort = await distinctAvailablePort(allocatedPorts);
allocatedPorts.add(jaegerPort);
const grafanaPort = await distinctAvailablePort(allocatedPorts);
const baseUrl = `http://127.0.0.1:${String(httpPort)}`;
const keepDeployment = process.env.AGENT_DOCK_PRODUCTION_CHECK_KEEP === "1";
const skipBuild = process.env.AGENT_DOCK_PRODUCTION_CHECK_SKIP_BUILD === "1";
const restoredProjectName = `${projectName}-restore`;
const processEnvironment = {
  ...process.env,
  AGENT_DOCK_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENT_DOCK_HTTP_BIND_ADDRESS: "127.0.0.1",
  AGENT_DOCK_HTTP_PORT: String(httpPort),
  AGENT_DOCK_PROMETHEUS_PORT: String(prometheusPort),
  AGENT_DOCK_JAEGER_PORT: String(jaegerPort),
  AGENT_DOCK_GRAFANA_PORT: String(grafanaPort),
  AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED: "true",
  AGENT_DOCK_PUBLIC_REGISTRATION_MAXIMUM_TENANTS: "4",
  AGENT_DOCK_SUPERVISOR_ID: supervisorId,
  COMPOSE_PROJECT_NAME: projectName,
};
let initialized = false;
let apiToken = "";
let recoveryDirectory;
let restoredDeployment;

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

function composeArgumentsFor(projectNameValue, environmentFileValue, args) {
  return [
    "compose",
    "--project-name",
    projectNameValue,
    "--env-file",
    environmentFileValue,
    "--file",
    composeFile,
    ...args,
  ];
}

function composeArguments(args) {
  return composeArgumentsFor(projectName, environmentFile, args);
}

function composeCapture(args, timeoutMs = 120_000) {
  return capture("docker", composeArguments(args), { timeoutMs });
}

function composeRun(args) {
  return run("docker", composeArguments(args));
}

function composeCaptureFor(deployment, args, timeoutMs = 120_000) {
  return capture(
    "docker",
    composeArgumentsFor(deployment.projectName, deployment.environmentFile, args),
    { timeoutMs, environment: deployment.environment },
  );
}

function composeRunFor(deployment, args) {
  return run(
    "docker",
    composeArgumentsFor(deployment.projectName, deployment.environmentFile, args),
    {
      environment: deployment.environment,
    },
  );
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

async function distinctAvailablePort(excluded) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await availablePort();
    if (!excluded.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a distinct loopback port");
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

async function waitForHealthyServiceIn(deployment, service, expectedCount = 1, timeoutMs = 90_000) {
  return waitFor(
    async () => {
      const output = await composeCaptureFor(deployment, ["ps", "--quiet", service]);
      const ids = output.length === 0 ? [] : output.split(/\r?\n/).filter(Boolean);
      if (ids.length !== expectedCount) return false;
      const statuses = await Promise.all(
        ids.map((id) => capture("docker", ["inspect", "--format", "{{.State.Health.Status}}", id])),
      );
      return statuses.every((status) => status === "healthy") ? ids : false;
    },
    `${deployment.projectName} ${service} health (${String(expectedCount)} replicas)`,
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

function cookieHeaders(cookie, extra = {}) {
  return { cookie, ...extra };
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^agent_dock_session=ads_[^;]+;/);
  assert.match(setCookie, /; HttpOnly(?:;|$)/);
  assert.match(setCookie, /; SameSite=Strict(?:;|$)/);
  return setCookie.split(";", 1)[0];
}

async function registerAccount(username, displayName, password, expectedStatus) {
  return http(
    "/v1/auth/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, displayName, password }),
    },
    expectedStatus,
  );
}

async function loginAccount(username, password, expectedStatus) {
  return http(
    "/v1/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    expectedStatus,
  );
}

async function postWithCookie(cookie, path, body, expectedStatus, idempotencyKey) {
  return http(
    path,
    {
      method: "POST",
      headers: cookieHeaders(cookie, {
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      }),
      body: JSON.stringify(body),
    },
    expectedStatus,
  );
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
    assert(["pi_session_snapshot", "workspace_snapshot", "patch"].includes(kind));
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
  await waitFor(
    async () =>
      (await psql(
        `select count(*) from session_leases where session_id = ${sqlLiteral(sessionId)}`,
      )) === "0",
    `session ${sessionId} lease release`,
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

async function assertWorkerSecurity(containerId, secretValues, expectedAssignment) {
  const inspected = JSON.parse(await capture("docker", ["inspect", containerId]))[0];
  const labels = inspected.Config.Labels ?? {};
  assert.equal(inspected.Config.User, "1000:1000");
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert(inspected.HostConfig.CapDrop.includes("ALL"));
  assert.equal(inspected.HostConfig.SecurityOpt.includes("no-new-privileges:true"), true);
  assert.equal(inspected.HostConfig.PidsLimit, 128);
  assert.equal(inspected.HostConfig.Memory, 768 * 1_024 * 1_024);
  assert.equal(inspected.HostConfig.NanoCpus, 1_000_000_000);
  assert.deepEqual(
    {
      tenantId: labels["agent-dock.tenant-id"],
      supervisorId: labels["agent-dock.supervisor-id"],
      bootId: labels["agent-dock.boot-id"],
      sandboxId: labels["agent-dock.sandbox-id"],
      commandId: labels["agent-dock.command-id"],
      sessionId: labels["agent-dock.session-id"],
      turnId: labels["agent-dock.turn-id"],
      attemptId: labels["agent-dock.attempt-id"],
      leaseId: labels["agent-dock.lease-id"],
      fencingToken: Number(labels["agent-dock.fencing-token"]),
    },
    expectedAssignment,
  );
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

async function assertOnlyExpectedLoopbackPortsPublished() {
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
    if (service !== "web" && service !== "observability-ingress") {
      assert.deepEqual(bindings, {}, `${service} unexpectedly publishes a host port`);
      continue;
    }
    const expected =
      service === "web"
        ? { "8080/tcp": httpPort }
        : {
            "3001/tcp": grafanaPort,
            "9090/tcp": prometheusPort,
            "16686/tcp": jaegerPort,
          };
    assert.deepEqual(Object.keys(bindings).sort(), Object.keys(expected).sort());
    for (const [containerPort, hostPort] of Object.entries(expected)) {
      assert.equal(bindings[containerPort].length, 1);
      assert.equal(bindings[containerPort][0].HostIp, "127.0.0.1");
      assert.equal(bindings[containerPort][0].HostPort, String(hostPort));
    }
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
  for (const service of [
    "database-bootstrap",
    "control-plane",
    "supervisor-host",
    "github-gateway",
  ]) {
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

async function assertExecutionBoundary() {
  const supervisorId = (await serviceContainerIds("supervisor-host"))[0];
  const managerId = (await serviceContainerIds("sandbox-manager"))[0];
  const githubGatewayId = (await serviceContainerIds("github-gateway"))[0];
  assert(supervisorId);
  assert(managerId);
  assert(githubGatewayId);
  const [supervisor, manager, githubGateway] = await Promise.all(
    [supervisorId, managerId, githubGatewayId].map(async (id) =>
      JSON.parse(await capture("docker", ["inspect", id])).at(0),
    ),
  );
  const hasDockerSocket = (container) =>
    (container.Mounts ?? []).some((mount) => mount.Destination === "/var/run/docker.sock");
  assert.equal(hasDockerSocket(supervisor), false);
  assert.equal(hasDockerSocket(manager), true);
  assert.equal(hasDockerSocket(githubGateway), false);
  assert.equal(supervisor.HostConfig.Privileged, false);
  assert.equal(manager.HostConfig.Privileged, false);
  assert.equal(supervisor.HostConfig.ReadonlyRootfs, true);
  assert.equal(manager.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(supervisor.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(supervisor.HostConfig.CapAdd ?? [], []);
  assert(manager.HostConfig.CapDrop.includes("ALL"));
  assert(
    manager.HostConfig.CapAdd.some(
      (capability) => capability === "DAC_READ_SEARCH" || capability === "CAP_DAC_READ_SEARCH",
    ),
  );
  const supervisorNetworks = Object.keys(supervisor.NetworkSettings.Networks ?? {});
  const managerNetworks = Object.keys(manager.NetworkSettings.Networks ?? {});
  const githubGatewayNetworks = Object.keys(githubGateway.NetworkSettings.Networks ?? {});
  assert(supervisorNetworks.some((name) => name.endsWith("_sandbox-control")));
  assert.equal(
    supervisorNetworks.some((name) => name.endsWith("_repository-egress")),
    false,
  );
  assert.deepEqual(
    managerNetworks.sort(),
    [`${projectName}_observability`, `${projectName}_sandbox-control`].sort(),
  );
  assert.deepEqual(
    githubGatewayNetworks.sort(),
    [`${projectName}_github-control`, `${projectName}_provider-egress`].sort(),
  );
  const githubEnvironment = githubGateway.Config.Env ?? [];
  for (const prefix of [
    "DATABASE_URL=",
    "DATABASE_URL_FILE=",
    "AWS_",
    "AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY",
    "AGENT_DOCK_SANDBOX_MANAGER_TOKEN",
  ]) {
    assert.equal(
      githubEnvironment.some((value) => value.startsWith(prefix)),
      false,
    );
  }
  const repositoryNetwork = JSON.parse(
    await capture("docker", ["network", "inspect", `${projectName}_repository-egress`]),
  ).at(0);
  assert.equal(repositoryNetwork.Name, `${projectName}_repository-egress`);
  assert.deepEqual(Object.keys(repositoryNetwork.Containers ?? {}), []);
  const managerEnvironment = manager.Config.Env ?? [];
  assert(managerEnvironment.includes("AGENT_DOCK_SANDBOX_PROVIDER=docker"));
  for (const prefix of [
    "DATABASE_URL=",
    "DATABASE_URL_FILE=",
    "AWS_",
    "AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY",
    "AGENT_DOCK_SUPERVISOR_ENROLLMENT_TOKEN",
  ]) {
    assert.equal(
      managerEnvironment.some((value) => value.startsWith(prefix)),
      false,
    );
  }
}

async function readSecretValues() {
  const names = [
    "api-token",
    "database-url",
    "github-gateway-token",
    "github-webhook-secret",
    "grafana-admin-password",
    "minio-root-password",
    "minio-root-user",
    "model-credential-master-key",
    "metrics-token",
    "postgres-password",
    "sandbox-manager-token",
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
      "github-app-private-key.pem",
      "github-gateway-token",
      "github-webhook-secret",
      "grafana-admin-password",
      "minio-root-password",
      "minio-root-user",
      "model-credential-master-key",
      "metrics-token",
      "postgres-password",
      "sandbox-manager-token",
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

async function assertProductSurface({ sessionId, runIds }) {
  report("validate_product_surface", { sessionId });
  const [runs, versions, usage, governance, context, operations, audit, ...runUsages] =
    await Promise.all([
      http(`/v1/sessions/${sessionId}/runs`, { headers: authenticatedHeaders() }, 200),
      http(
        `/v1/sessions/${sessionId}/workspace-versions`,
        {
          headers: authenticatedHeaders(),
        },
        200,
      ),
      http("/v1/usage", { headers: authenticatedHeaders() }, 200),
      http("/v1/model-governance", { headers: authenticatedHeaders() }, 200),
      http(`/v1/sessions/${sessionId}/context`, { headers: authenticatedHeaders() }, 200),
      http("/v1/operations/summary", { headers: authenticatedHeaders() }, 200),
      http("/v1/operations/audit", { headers: authenticatedHeaders() }, 200),
      ...runIds.map((runId) =>
        http(`/v1/runs/${runId}/usage`, { headers: authenticatedHeaders() }, 200),
      ),
    ]);
  assert(runIds.every((runId) => runs.body.runs.some((run) => run.runId === runId)));
  assert.equal(versions.body.versions.length, runIds.length);
  assert.equal(versions.body.currentVersionId, versions.body.versions[0].versionId);
  const completedModelRequests = runUsages.reduce(
    (count, response) =>
      count + response.body.modelRequests.filter((request) => request.state === "completed").length,
    0,
  );
  report("validate_product_usage", {
    tenantRequests: usage.body.totals.requests,
    completedModelRequests,
    requestsByRun: runUsages.map((response, index) => ({
      runId: runIds[index],
      states: response.body.modelRequests.map((request) => request.state),
    })),
  });
  // The deterministic production acceptance provider is intentionally embedded in the trusted
  // runner. It exercises Pi and the remote tool boundary without consuming a tenant credential,
  // so Model Gateway request and usage rows are expected to remain empty here. The governed
  // non-zero path is covered by the Model Gateway integration suite.
  assert(runUsages.every((response) => response.body.modelRequests.length === 0));
  assert.equal(completedModelRequests, 0);
  assert(usage.body.totals.requests >= completedModelRequests);
  assert(governance.body.limits.maximumModelRequestsPerRun > 0);
  assert.equal(context.body.layers.length, 6);
  assert(operations.body.runs.completed >= runIds.length);
  assert(audit.body.events.some((event) => event.category === "run_attempt"));
  assert.equal(
    audit.body.events.some((event) => event.category === "model"),
    false,
  );

  const selectedRunId = runIds.at(-1);
  const [run, tests] = await Promise.all([
    http(`/v1/runs/${selectedRunId}`, { headers: authenticatedHeaders() }, 200),
    http(`/v1/runs/${selectedRunId}/test-results`, { headers: authenticatedHeaders() }, 200),
  ]);
  assert.equal(run.body.state, "completed");
  assert.equal(run.body.attempts.at(-1).state, "completed");
  assert(run.body.attempts.at(-1).transitions.length >= 5);
  assert(tests.body.results.some((result) => result.status === "passed"));

  const currentVersion = versions.body.versions[0];
  const firstVersion = versions.body.versions.at(-1);
  const [version, files, comparison] = await Promise.all([
    http(
      `/v1/workspace-versions/${currentVersion.versionId}`,
      { headers: authenticatedHeaders() },
      200,
    ),
    http(
      `/v1/workspace-versions/${currentVersion.versionId}/files`,
      { headers: authenticatedHeaders() },
      200,
    ),
    http(
      `/v1/workspace-versions/${firstVersion.versionId}/compare/${currentVersion.versionId}`,
      { headers: authenticatedHeaders() },
      200,
    ),
  ]);
  assert.equal(version.body.revision, currentVersion.revision);
  assert.equal(files.body.files.length, currentVersion.fileCount);
  assert.equal(comparison.body.baseVersionId, firstVersion.versionId);
  const sourceFile = files.body.files.find((file) => file.path.endsWith("Calculator.java"));
  assert(sourceFile !== undefined);
  const source = await http(
    `/v1/workspace-versions/${currentVersion.versionId}/file?path=${encodeURIComponent(sourceFile.path)}`,
    { headers: authenticatedHeaders() },
    200,
  );
  assert.match(source.text, /return left \+ right/);
  const patchArtifact = firstVersion.artifacts.find((artifact) => artifact.kind === "patch");
  assert(patchArtifact !== undefined);
  const patch = await http(
    `/v1/artifacts/${patchArtifact.artifactId}/content`,
    { headers: authenticatedHeaders() },
    200,
  );
  assert.match(patch.text, /return left \+ right/);

  const fork = (
    await post(
      `/v1/sessions/${sessionId}/forks`,
      { versionId: currentVersion.versionId },
      201,
      `production-fork-${suffix}`,
    )
  ).body;
  assert.equal(fork.kind, "fork");
  assert.equal(fork.replayed, false);
  const archive = (
    await post(
      `/v1/sessions/${fork.forkedSessionId}/archive`,
      { archived: true },
      201,
      `production-archive-${suffix}`,
    )
  ).body;
  assert.equal(archive.kind, "archive");
  const unarchive = (
    await post(
      `/v1/sessions/${fork.forkedSessionId}/archive`,
      { archived: false },
      201,
      `production-unarchive-${suffix}`,
    )
  ).body;
  assert.equal(unarchive.kind, "unarchive");
  const rollback = (
    await post(
      `/v1/sessions/${sessionId}/workspace-rollback`,
      {
        versionId: firstVersion.versionId,
        expectedCurrentVersionId: currentVersion.versionId,
      },
      201,
      `production-rollback-old-${suffix}`,
    )
  ).body;
  assert.equal(rollback.kind, "rollback");
  const restoreLatest = (
    await post(
      `/v1/sessions/${sessionId}/workspace-rollback`,
      {
        versionId: currentVersion.versionId,
        expectedCurrentVersionId: firstVersion.versionId,
      },
      201,
      `production-rollback-latest-${suffix}`,
    )
  ).body;
  assert.equal(restoreLatest.versionId, currentVersion.versionId);

  const auditAfterOperations = await http(
    "/v1/operations/audit",
    { headers: authenticatedHeaders() },
    200,
  );
  assert(auditAfterOperations.body.events.some((event) => event.category === "workspace"));

  const document = await http("/", {}, 200);
  assert.match(document.text, /<title>AgentDock<\/title>/);
  const scriptPath = document.text.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.equal(typeof scriptPath, "string");
  const bundle = await http(scriptPath, {}, 200);
  assert.match(bundle.text, /登录后继续你的对话/);
  assert.match(bundle.text, /注册后即可开始使用，无需配置模型/);
  assert.match(bundle.text, /最近对话/);
  assert.match(bundle.text, /给 AgentDock 发送消息/);
  assert.match(bundle.text, /Session inspector/);
  assert.match(bundle.text, /GitHub PR delivery/);
  return {
    currentVersion,
    forkedSessionId: fork.forkedSessionId,
    auditEvents: auditAfterOperations.body.events.length,
  };
}

async function performRecoveryDrill({ sessionId, secondTenantSessionId, tenantBToken, cursor }) {
  report("stop_for_encrypted_backup", { projectName });
  await composeRun(["down", "--remove-orphans", "--timeout", "15"]);
  recoveryDirectory = await mkdtemp(join(tmpdir(), `agent-dock-recovery-${suffix}-`));
  const passphraseFile = resolve(recoveryDirectory, "backup-passphrase");
  const backupPath = resolve(recoveryDirectory, "production.adbackup");
  const restoredRuntimeDirectory = resolve(recoveryDirectory, "restored-runtime");
  await writeFile(passphraseFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
  await chmod(passphraseFile, 0o600);

  report("create_encrypted_backup");
  await run(
    process.execPath,
    [
      "scripts/production-backup.mjs",
      "--output",
      backupPath,
      "--passphrase-file",
      passphraseFile,
      "--runtime-dir",
      runtimeDirectory,
      "--project-name",
      projectName,
    ],
    { environment: processEnvironment },
  );
  const backupSizeBytes = (await stat(backupPath)).size;
  assert(backupSizeBytes > 0);

  report("restore_encrypted_backup", { restoredProjectName });
  await run(
    process.execPath,
    [
      "scripts/production-restore.mjs",
      "--input",
      backupPath,
      "--passphrase-file",
      passphraseFile,
      "--runtime-dir",
      restoredRuntimeDirectory,
      "--project-name",
      restoredProjectName,
      "--confirm-empty",
    ],
    { environment: processEnvironment },
  );
  const restoredEnvironmentFile = resolve(restoredRuntimeDirectory, ".env");
  const restoredEnvironment = {
    ...processEnvironment,
    AGENT_DOCK_RUNTIME_DIRECTORY: restoredRuntimeDirectory,
    COMPOSE_PROJECT_NAME: restoredProjectName,
  };
  restoredDeployment = {
    projectName: restoredProjectName,
    environmentFile: restoredEnvironmentFile,
    environment: restoredEnvironment,
  };
  await composeRunFor(restoredDeployment, ["up", "--detach", "--wait"]);
  await Promise.all(
    [
      "postgres",
      "minio",
      "control-plane",
      "supervisor-host",
      "sandbox-manager",
      "github-gateway",
      "web",
      "observability-ingress",
    ].map((service) => waitForHealthyServiceIn(restoredDeployment, service, 1, 120_000)),
  );

  const [identity, conversationsA, conversationsB, restoredVersions, restoredAudit] =
    await Promise.all([
      http("/v1/identity", { headers: authenticatedHeaders() }, 200),
      http("/v1/conversations", { headers: authenticatedHeaders() }, 200),
      http("/v1/conversations", { headers: authenticatedHeaders({}, tenantBToken) }, 200),
      http(
        `/v1/sessions/${sessionId}/workspace-versions`,
        { headers: authenticatedHeaders() },
        200,
      ),
      http("/v1/operations/audit", { headers: authenticatedHeaders() }, 200),
    ]);
  assert.match(identity.body.tenantId, /^[0-9a-f-]{36}$/i);
  assert(conversationsA.body.conversations.some((item) => item.sessionId === sessionId));
  assert(
    conversationsB.body.conversations.some((item) => item.sessionId === secondTenantSessionId),
  );
  assert.equal(restoredVersions.body.currentVersionId, restoredVersions.body.versions[0].versionId);
  assert(restoredAudit.body.events.some((event) => event.category === "workspace"));
  const replay = await readSessionEventsUntil(sessionId, 0, (event) => event.seq === cursor);
  assert.equal(replay.cursor, cursor);

  const restoredFollowUp = (
    await post(
      `/v1/sessions/${sessionId}/turns`,
      { prompt: "Verify the restored backup can continue this coding session." },
      202,
      `production-restored-followup-${suffix}`,
    )
  ).body;
  const restoredStream = await readSessionEventsUntil(
    sessionId,
    cursor,
    isTerminalFor(restoredFollowUp.turnId),
    120_000,
  );
  assert.equal(restoredStream.events.at(-1).type, "turn.completed");
  assert(restoredStream.cursor > cursor);
  await waitFor(async () => (await managedWorkerIds()).length === 0, "restored worker removal");
  report("recovery_drill_passed", {
    backupSizeBytes,
    restoredProjectName,
    restoredCursor: restoredStream.cursor,
  });
  return { backupSizeBytes, restoredCursor: restoredStream.cursor };
}

async function main() {
  report("initialize", {
    projectName,
    runtimeDirectory,
    httpPort,
    prometheusPort,
    jaegerPort,
    grafanaPort,
  });
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
      "sandbox-manager",
      "github-gateway",
      "web",
      "tool-sandbox-image",
    ]);
  }

  report("start_topology");
  await composeRun(["up", "--detach", "--wait"]);
  await Promise.all([
    waitForHealthyService("postgres"),
    waitForHealthyService("minio"),
    waitForHealthyService("control-plane"),
    waitForHealthyService("supervisor-host"),
    waitForHealthyService("sandbox-manager"),
    waitForHealthyService("github-gateway"),
    waitForHealthyService("web"),
    waitForHealthyService("observability-ingress"),
  ]);
  report("repeat_bootstrap");
  await composeRun(["run", "--rm", "--no-deps", "minio-bootstrap"]);
  await composeRun(["run", "--rm", "--no-deps", "database-bootstrap"]);
  await assertOnlyExpectedLoopbackPortsPublished();
  await assertApplicationIdentity();
  await assertExecutionBoundary();
  await assertTenantNeutralControlPlaneRuntime();
  await assertObjectStorePolicy(applicationAccessKey);

  const health = await http("/healthz", {}, 200);
  assert.equal(health.text.trim(), "ok");
  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${String(prometheusPort)}/api/v1/targets`);
      if (!response.ok) return false;
      const body = await response.json();
      const targets = body?.data?.activeTargets;
      return Array.isArray(targets) &&
        targets.length === 3 &&
        targets.every((target) => target.health === "up")
        ? targets
        : false;
    },
    "three healthy Prometheus scrape targets",
    60_000,
  );
  const grafanaHealth = await fetch(`http://127.0.0.1:${String(grafanaPort)}/api/health`);
  assert.equal(grafanaHealth.status, 200);
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

  report("validate_product_account_flow");
  const accountUsername = `product-${suffix}`;
  const accountPassword = `acceptance-${suffix}-password`;
  const accountRegistration = await registerAccount(
    accountUsername,
    "Product User",
    accountPassword,
    201,
  );
  assert.equal(Object.hasOwn(accountRegistration.body, "apiToken"), false);
  assert.equal(Object.hasOwn(accountRegistration.body, "modelConfiguration"), false);
  assert.equal(accountRegistration.body.identity.displayName, "Product User");
  const initialProductCookie = sessionCookie(accountRegistration.response);
  secretValues.push(
    accountPassword,
    initialProductCookie.slice(initialProductCookie.indexOf("=") + 1),
  );
  const productIdentity = await http(
    "/v1/identity",
    { headers: cookieHeaders(initialProductCookie) },
    200,
  );
  assert.equal(productIdentity.body.tenantId, accountRegistration.body.identity.tenantId);
  const inheritedModel = await http(
    "/v1/model-configuration",
    { headers: cookieHeaders(initialProductCookie) },
    200,
  );
  assert.deepEqual(inheritedModel.body, {
    mode: "deterministic",
    provider: "agent-dock-fake",
    modelId: "agent-dock-fake",
    configured: false,
    credentialVersion: 1,
    updatedAt: inheritedModel.body.updatedAt,
  });
  const rejectedModelKey = `sk-${"m".repeat(48)}`;
  secretValues.push(rejectedModelKey);
  await http(
    "/v1/model-configuration",
    {
      method: "PUT",
      headers: cookieHeaders(initialProductCookie, { "content-type": "application/json" }),
      body: JSON.stringify({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: rejectedModelKey,
      }),
    },
    403,
  );
  const productProject = (
    await postWithCookie(
      initialProductCookie,
      "/v1/projects",
      { name: `Product conversation ${suffix}`, source: { kind: "empty" } },
      201,
    )
  ).body;
  assert.equal(productProject.source.kind, "empty");
  const productSession = (
    await postWithCookie(
      initialProductCookie,
      `/v1/projects/${productProject.projectId}/sessions`,
      { workspaceId: productProject.workspaceId },
      201,
    )
  ).body;
  const productConversations = await http(
    "/v1/conversations",
    { headers: cookieHeaders(initialProductCookie) },
    200,
  );
  assert.deepEqual(
    productConversations.body.conversations.map((conversation) => conversation.sessionId),
    [productSession.sessionId],
  );
  const logout = await postWithCookie(initialProductCookie, "/v1/auth/logout", {}, 200);
  assert.deepEqual(logout.body, { loggedOut: true });
  assert.match(logout.response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  await http("/v1/identity", { headers: cookieHeaders(initialProductCookie) }, 401);
  const accountLogin = await loginAccount(accountUsername.toUpperCase(), accountPassword, 200);
  const productCookie = sessionCookie(accountLogin.response);
  assert.notEqual(productCookie, initialProductCookie);
  secretValues.push(productCookie.slice(productCookie.indexOf("=") + 1));

  report("validate_public_registration");
  await registerTenant("INVALID SLUG", "Invalid tenant", 400);
  assert.equal(await psql("select count(*) from tenants"), "2");
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
  assert.equal(await psql("select count(*) from tenants"), "4");

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
  await assertCheckpointObjects(sessionB.sessionId, 3, tenantBId);
  const tenantBVersions = await http(
    `/v1/sessions/${sessionB.sessionId}/workspace-versions`,
    { headers: authenticatedHeaders({}, tenantBToken) },
    200,
  );
  assert.equal(tenantBVersions.body.versions.length, 1);
  assert.equal(tenantBVersions.body.currentVersionId, tenantBVersions.body.versions[0].versionId);
  const tenantBTests = await http(
    `/v1/runs/${repairB.runId}/test-results`,
    { headers: authenticatedHeaders({}, tenantBToken) },
    200,
  );
  assert(tenantBTests.body.results.length >= 1);
  assert(tenantBTests.body.results.some((result) => result.status === "passed"));
  assert(tenantBTests.body.results.some((result) => result.status === "failed"));
  assert(
    tenantBTests.body.results.every(
      (result) => result.workspaceVersionId === tenantBVersions.body.currentVersionId,
    ),
  );

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
  const productConversationListAfterTenantB = await http(
    "/v1/conversations",
    { headers: cookieHeaders(productCookie) },
    200,
  );
  assert.deepEqual(
    productConversationListAfterTenantB.body.conversations.map(
      (conversation) => conversation.sessionId,
    ),
    [productSession.sessionId],
  );
  await http(
    `/v1/conversations/${sessionB.sessionId}`,
    { headers: cookieHeaders(productCookie) },
    404,
  );

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
  await assertCheckpointObjects(session.sessionId, 3);

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
  await assertCheckpointObjects(session.sessionId, 6);

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
  await assertCheckpointObjects(session.sessionId, 9);

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
  const cancellationRun = (
    await http(`/v1/runs/${cancellationTurn.runId}`, { headers: authenticatedHeaders() }, 200)
  ).body;
  const cancellationAttempt = cancellationRun.attempts.find(
    (attempt) => attempt.attemptId === cancellationRun.currentAttemptId,
  );
  assert(cancellationAttempt !== undefined);
  await assertWorkerSecurity(workerId, secretValues, {
    tenantId: identityA.body.tenantId,
    supervisorId,
    bootId: freshBoot.bootId,
    sandboxId: cancellationAttempt.sandboxId,
    commandId: cancellationTurn.commandId,
    sessionId: cancellationSession.sessionId,
    turnId: cancellationTurn.turnId,
    attemptId: cancellationAttempt.attemptId,
    leaseId: cancellationAttempt.leaseId,
    fencingToken: cancellationAttempt.fencingToken,
  });
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
  await assertCheckpointObjects(sessionB.sessionId, 3, tenantBId);
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

  const productEvidence = await assertProductSurface({
    sessionId: session.sessionId,
    runIds: [recoveredRepair.runId, followUp.runId, postRestart.runId],
  });

  await assertNoSecretsInDeployment(secretValues, [
    ...tenantBStream.events,
    ...tenantBReplay.events,
    ...repairEvents,
    ...followUpStream.events,
    ...postRestartStream.events,
    ...cancellationStarted.events,
    ...cancellationTerminal.events,
  ]);
  await assertOnlyExpectedLoopbackPortsPublished();
  const jaegerServices = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${String(jaegerPort)}/api/services`);
      if (!response.ok) return false;
      const body = await response.json();
      return Array.isArray(body.data) && body.data.length >= 3 ? body.data : false;
    },
    "cross-service Jaeger traces",
    60_000,
  );
  const recoveryEvidence = keepDeployment
    ? undefined
    : await performRecoveryDrill({
        sessionId: session.sessionId,
        secondTenantSessionId: sessionB.sessionId,
        tenantBToken,
        cursor: 22,
      });
  report("production_check_passed", {
    projectName,
    repairedSessionId: session.sessionId,
    secondTenantSessionId: sessionB.sessionId,
    oldBootId: bootBeforeReconnect.bootId,
    freshBootId: freshBoot.bootId,
    durableEvents: 22,
    registeredTenants: 4,
    prometheusTargets: 3,
    jaegerServices: jaegerServices.length,
    productWorkspaceVersion: productEvidence.currentVersion.versionNumber,
    productAuditEvents: productEvidence.auditEvents,
    forkedSessionId: productEvidence.forkedSessionId,
    recovery: recoveryEvidence,
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
    const restoredLogs =
      restoredDeployment === undefined
        ? ""
        : await composeCaptureFor(
            restoredDeployment,
            ["logs", "--no-color", "--tail", "120"],
            60_000,
          ).catch(() => "");
    if (logs.length > 0) process.stderr.write(`${logs}\n`);
    if (restoredLogs.length > 0) process.stderr.write(`${restoredLogs}\n`);
  }
} finally {
  if (restoredDeployment !== undefined && !keepDeployment) {
    await composeRunFor(restoredDeployment, [
      "down",
      "--volumes",
      "--remove-orphans",
      "--timeout",
      "15",
    ]).catch(() => undefined);
  }
  if (initialized && !keepDeployment) {
    await composeRun(["down", "--volumes", "--remove-orphans", "--timeout", "15"]).catch(
      () => undefined,
    );
  }
  if (!keepDeployment) {
    await rm(runtimeDirectory, { recursive: true, force: true });
    if (recoveryDirectory !== undefined) {
      await rm(recoveryDirectory, { recursive: true, force: true });
    }
  } else report("deployment_preserved", { projectName, runtimeDirectory, baseUrl });
}

if (failure !== undefined) throw failure;
