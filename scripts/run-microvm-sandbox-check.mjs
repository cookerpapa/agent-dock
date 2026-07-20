import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image = process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE ?? "agent-dock/tool-sandbox:microvm-check";
const dockerCommand = process.env.AGENT_DOCK_DOCKER_COMMAND ?? "docker";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 2 * 1_024 * 1_024,
        timeout: timeoutMs,
      },
      (error, stdout) => (error ? rejectPromise(error) : resolvePromise(stdout.trim())),
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
      else
        rejectPromise(
          new Error(
            `${command} ${args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
    });
  });
}

const engineVersion = await capture(dockerCommand, ["version", "--format", "{{.Server.Version}}"]);
const sandboxVersion = await capture(dockerCommand, ["sandbox", "version"]);
if (!/Server Version:\s*v?\d+\.\d+\.\d+/.test(sandboxVersion)) {
  throw new Error("Docker Sandboxes client/server is unavailable.");
}
const inventory = await capture(dockerCommand, ["sandbox", "ls", "--quiet"]);
if (inventory.split(/\r?\n/).some((name) => name.startsWith("admv-"))) {
  throw new Error("A managed AgentDock microVM already exists; reconcile it before this gate.");
}

process.stdout.write(
  `${JSON.stringify({ dockerCommand, engineVersion, sandboxVersion: sandboxVersion.split(/\r?\n/), image })}\n`,
);
await run(dockerCommand, [
  "build",
  "--file",
  "packages/tool-sandbox/Dockerfile",
  "--tag",
  image,
  ".",
]);

const environment = {
  ...process.env,
  AGENT_DOCK_DOCKER_COMMAND: dockerCommand,
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
    "test/docker-microvm-sandbox-provider.integration.test.ts",
  ],
  { ...environment, AGENT_DOCK_MICROVM_SANDBOX_PROVIDER_TEST: "1" },
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
  { ...environment, AGENT_DOCK_REMOTE_TOOL_MICROVM_TEST: "1" },
);

const remaining = await capture(dockerCommand, ["sandbox", "ls", "--quiet"]);
if (remaining.split(/\r?\n/).some((name) => name.startsWith("admv-"))) {
  throw new Error("The Docker microVM gate left a managed VM behind.");
}
process.stdout.write("docker_microvm_sandbox_check_passed\n");
