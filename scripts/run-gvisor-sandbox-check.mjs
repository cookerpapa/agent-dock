import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image = process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE ?? "agent-dock/tool-sandbox:provider-check";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function capture(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1_024 * 1_024, timeout: 15_000 },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function run(command, args, environment = process.env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `${command} ${args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
    });
  });
}

async function resolveDockerCommand() {
  const configured = process.env.AGENT_DOCK_DOCKER_COMMAND;
  if (process.platform !== "linux") {
    throw new Error("The gVisor gate requires a native Linux Docker Engine.");
  }
  const candidates = [configured ?? "docker"];
  for (const candidate of candidates) {
    try {
      const version = await capture(candidate, ["version", "--format", "{{.Server.Version}}"]);
      return { command: candidate, version };
    } catch {
      // Try the next explicit local Docker CLI name.
    }
  }
  throw new Error(
    "The native Linux Docker Engine is unavailable. Install the AgentDock gVisor host runtime.",
  );
}

const docker = await resolveDockerCommand();
const runtime = JSON.parse(
  await capture(docker.command, ["info", "--format", "{{json .Runtimes.runsc}}"]),
);
if (
  runtime === null ||
  typeof runtime !== "object" ||
  !/(?:^|\/)runsc$/.test(runtime.path ?? "") ||
  !Array.isArray(runtime.runtimeArgs) ||
  !runtime.runtimeArgs.includes("--platform=kvm")
) {
  throw new Error("Docker Engine does not expose the required runsc KVM runtime.");
}
process.stdout.write(
  `${JSON.stringify({
    dockerCommand: docker.command,
    engineVersion: docker.version,
    runtime: { path: runtime.path, runtimeArgs: runtime.runtimeArgs },
    image,
  })}\n`,
);
const proxyBuildArguments = [];
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
  const value = process.env[name];
  if (value !== undefined) {
    if (value.length > 2_048 || /[\r\n\0]/.test(value)) {
      throw new Error(`${name} is not a bounded build proxy value.`);
    }
    proxyBuildArguments.push("--build-arg", `${name}=${value}`);
  }
}

await run(docker.command, [
  "build",
  // The host proxy is intentionally bound to loopback. This is a trusted image build,
  // so host networking lets BuildKit reach it without exposing the proxy to sandboxes.
  "--network",
  "host",
  ...proxyBuildArguments,
  "--file",
  "packages/tool-sandbox/Dockerfile",
  "--tag",
  image,
  ".",
]);

const testEnvironment = {
  ...process.env,
  AGENT_DOCK_DOCKER_COMMAND: docker.command,
  AGENT_DOCK_TOOL_SANDBOX_IMAGE: image,
};

await run(
  npmCommand,
  [
    "exec",
    "--workspace",
    "@agent-dock/sandbox-manager",
    "--",
    "vitest",
    "--run",
    "test/gvisor-sandbox-provider.integration.test.ts",
  ],
  { ...testEnvironment, AGENT_DOCK_GVISOR_SANDBOX_TEST: "1" },
);

await run(
  npmCommand,
  [
    "exec",
    "--workspace",
    "@agent-dock/sandbox-supervisor",
    "--",
    "vitest",
    "--run",
    "test/remote-tool-sandbox-turn-runner.integration.test.ts",
  ],
  { ...testEnvironment, AGENT_DOCK_REMOTE_TOOL_SANDBOX_TEST: "1" },
);

const remaining = await capture(docker.command, [
  "ps",
  "--all",
  "--quiet",
  "--filter",
  "label=agent-dock.managed=true",
]);
if (remaining.length > 0) {
  throw new Error("The gVisor gate left a managed Tool Sandbox behind.");
}
process.stdout.write("gvisor_sandbox_check_passed\n");
