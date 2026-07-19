import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image = process.env.AGENT_DOCK_DOCKER_IMAGE ?? "agent-dock/pi-workspace:phase1";
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
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
  });
}

async function resolveDockerCommand() {
  const configured = process.env.AGENT_DOCK_DOCKER_COMMAND;
  const candidates = configured
    ? [configured]
    : process.platform === "win32"
      ? ["docker.exe"]
      : ["docker", "docker.exe"];
  for (const candidate of candidates) {
    try {
      const version = await capture(candidate, ["version", "--format", "{{.Server.Version}}"]);
      return { command: candidate, version };
    } catch {
      // Try the next explicit local Docker CLI name. No shell lookup is used.
    }
  }
  throw new Error(
    "Docker Engine is unavailable. Start Docker Desktop or set AGENT_DOCK_DOCKER_COMMAND.",
  );
}

const docker = await resolveDockerCommand();
process.stdout.write(
  `${JSON.stringify({ dockerCommand: docker.command, engineVersion: docker.version, image })}\n`,
);

await run(docker.command, [
  "build",
  "--file",
  "packages/sandbox-supervisor/Dockerfile",
  "--tag",
  image,
  ".",
]);

const testEnvironment = {
  ...process.env,
  AGENT_DOCK_DOCKER_SANDBOX_TEST: "1",
  AGENT_DOCK_DOCKER_COMMAND: docker.command,
  AGENT_DOCK_DOCKER_IMAGE: image,
};

await run(
  npmCommand,
  [
    "exec",
    "--workspace",
    "@agent-dock/sandbox-supervisor",
    "--",
    "vitest",
    "--run",
    "test/docker-sandbox-turn-runner.integration.test.ts",
  ],
  testEnvironment,
);
await run(
  npmCommand,
  [
    "exec",
    "--workspace",
    "@agent-dock/control-plane",
    "--",
    "vitest",
    "--run",
    "test/control-plane-api.test.ts",
  ],
  testEnvironment,
);
