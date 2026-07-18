import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const services = ["pi-extension-compat", "pi-embedded-rehydrate"];

function runDocker(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `docker ${args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
  });
}

async function captureDocker(args) {
  const { stdout } = await execFileAsync("docker", args, {
    cwd: repositoryRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function requireObject(value, description) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), description);
  return value;
}

function assertEmpty(value, description) {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    assert.equal(value.length, 0, description);
    return;
  }
  assert.equal(Object.keys(requireObject(value, description)).length, 0, description);
}

function verifyContainer(service, inspected) {
  const container = requireObject(inspected, `${service} inspect result must be an object`);
  const config = requireObject(container.Config, `${service} Config must exist`);
  const host = requireObject(container.HostConfig, `${service} HostConfig must exist`);
  const tmpfs = requireObject(host.Tmpfs, `${service} must define tmpfs`);

  assert.equal(config.User, "1000:1000", `${service} must use the non-root runtime identity`);
  assert.equal(host.ReadonlyRootfs, true, `${service} root filesystem must be read-only`);
  assert.equal(host.NetworkMode, "none", `${service} must have no runtime network`);
  assert.equal(host.Init, true, `${service} must use an init process`);
  assert.ok(host.CapDrop?.includes("ALL"), `${service} must drop every Linux capability`);
  assert.ok(
    host.SecurityOpt?.includes("no-new-privileges:true"),
    `${service} must set no-new-privileges`,
  );
  assert.equal(host.PidsLimit, 128, `${service} must enforce its PID limit`);
  assert.equal(host.Memory, 512 * 1024 * 1024, `${service} must enforce its memory limit`);
  assert.equal(host.NanoCpus, 1_000_000_000, `${service} must enforce its CPU limit`);
  assert.match(
    String(tmpfs["/tmp"]),
    /(?:^|,)size=(?:64m|67108864)(?:,|$)/,
    `${service} must bound /tmp to 64 MiB`,
  );
  assert.match(String(tmpfs["/tmp"]), /(?:^|,)noexec(?:,|$)/, `${service} /tmp must be noexec`);
  assert.match(String(tmpfs["/tmp"]), /(?:^|,)nosuid(?:,|$)/, `${service} /tmp must be nosuid`);
  assert.match(String(tmpfs["/tmp"]), /(?:^|,)nodev(?:,|$)/, `${service} /tmp must be nodev`);
  assertEmpty(host.Binds, `${service} must not bind host paths`);
  assertEmpty(container.Mounts, `${service} must not mount host or named volumes`);
  assert.equal(host.Privileged, false, `${service} must not be privileged`);
  assert.equal(host.PidMode, "", `${service} must not share the host PID namespace`);
  assert.equal(host.IpcMode, "private", `${service} must use a private IPC namespace`);
  assertEmpty(host.PortBindings, `${service} must not publish ports`);
  assertEmpty(host.Devices, `${service} must not expose host devices`);

  const environment = Object.fromEntries(
    (config.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return separator === -1
        ? [entry, ""]
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  assert.equal(environment.AGENT_DOCK_REQUIRE_NON_ROOT, "1");
  assert.equal(environment.PI_OFFLINE, "1");
  assert.equal(environment.PI_SKIP_VERSION_CHECK, "1");
  const sensitiveEnvironmentNames = Object.keys(environment).filter((name) =>
    /api[_-]?key|token|secret|password|credential|auth/i.test(name),
  );
  assert.deepEqual(
    sensitiveEnvironmentNames,
    [],
    `${service} runtime environment must not contain credential-like names`,
  );

  return {
    service,
    user: config.User,
    readonlyRootfs: host.ReadonlyRootfs,
    networkMode: host.NetworkMode,
    capDrop: host.CapDrop,
    securityOpt: host.SecurityOpt,
    pidsLimit: host.PidsLimit,
    memoryBytes: host.Memory,
    nanoCpus: host.NanoCpus,
    tmpfs: tmpfs["/tmp"],
    hostBinds: 0,
    publishedPorts: 0,
    devices: 0,
  };
}

async function removeComposeResources() {
  await runDocker(["compose", "rm", "--force", "--stop"]).catch(() => undefined);
  await runDocker(["compose", "down", "--remove-orphans"]).catch(() => undefined);
}

try {
  const engineVersion = await captureDocker(["version", "--format", "{{.Server.Version}}"]).catch(
    (error) => {
      throw new Error(
        `Docker Engine is unavailable. Enable Docker Desktop WSL integration first. ${String(error)}`,
      );
    },
  );
  const composeVersion = await captureDocker(["compose", "version", "--short"]);
  process.stdout.write(`${JSON.stringify({ engineVersion, composeVersion })}\n`);

  await runDocker(["compose", "config", "--quiet"]);
  await runDocker(["compose", "build", "--pull"]);

  for (const service of services) {
    await runDocker(["compose", "create", service]);
    const containerId = await captureDocker(["compose", "ps", "--all", "--quiet", service]);
    assert.ok(containerId.length > 0, `${service} did not create an inspectable container`);
    const inspectResult = JSON.parse(await captureDocker(["inspect", containerId]));
    assert.ok(Array.isArray(inspectResult) && inspectResult.length === 1);
    process.stdout.write(
      `${JSON.stringify({ hostConfig: verifyContainer(service, inspectResult[0]) }, null, 2)}\n`,
    );
    await runDocker(["compose", "rm", "--force", "--stop", service]);
    await runDocker(["compose", "run", "--rm", "--no-deps", service]);
  }
} finally {
  await removeComposeResources();
}
