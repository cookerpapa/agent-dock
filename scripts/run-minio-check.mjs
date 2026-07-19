import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const containerName = `agent-dock-minio-check-${process.pid}-${randomUUID().slice(0, 8)}`;
const accessKeyId = `agentdock${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const secretAccessKey = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
const bucket = `agent-dock-${randomUUID()}`;
const keyPrefix = `integration/${randomUUID()}`;

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

function run(command, args, environment, description) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", () => rejectPromise(new Error(`${description} could not start`)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${description} failed (code=${String(code)}, signal=${String(signal)})`),
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
      // Try the next explicit Docker CLI name without invoking a shell.
    }
  }
  throw new Error(
    "Docker Engine is unavailable. Start Docker Desktop or set AGENT_DOCK_DOCKER_COMMAND.",
  );
}

async function waitUntilHealthy(endpoint) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/minio/health/live`);
      if (response.ok) return;
    } catch {
      // The disposable server may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Disposable MinIO did not become healthy within 30 seconds");
}

async function pullPinnedImage(dockerCommand) {
  try {
    await capture(dockerCommand, ["image", "inspect", image, "--format", "{{.Id}}"]);
    return;
  } catch {
    // A clean checkout runner must fetch the exact digest before use.
  }
  let lastFailure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await run(
        dockerCommand,
        ["pull", image],
        process.env,
        `Pinned MinIO image pull attempt ${String(attempt)}`,
      );
      return;
    } catch (error) {
      lastFailure = error;
      if (attempt < 3) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      }
    }
  }
  throw lastFailure;
}

const docker = await resolveDockerCommand();
const containerEnvironment = {
  ...process.env,
  MINIO_ROOT_USER: accessKeyId,
  MINIO_ROOT_PASSWORD: secretAccessKey,
};
let containerStarted = false;

try {
  await pullPinnedImage(docker.command);
  await run(
    docker.command,
    [
      "run",
      "--detach",
      "--rm",
      "--pull",
      "never",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::9000",
      "--env",
      "MINIO_ROOT_USER",
      "--env",
      "MINIO_ROOT_PASSWORD",
      image,
      "server",
      "/data",
      "--console-address",
      ":9001",
    ],
    containerEnvironment,
    "Disposable MinIO container",
  );
  containerStarted = true;

  const portOutput = await capture(docker.command, ["port", containerName, "9000/tcp"]);
  const portMatch = /:(\d+)\s*$/.exec(portOutput);
  if (portMatch?.[1] === undefined) {
    throw new Error("Docker did not report the disposable MinIO loopback port");
  }
  const endpoint = `http://127.0.0.1:${portMatch[1]}`;
  await waitUntilHealthy(endpoint);

  process.stdout.write(
    `${JSON.stringify({ engineVersion: docker.version, image, fixture: "loopback-only" })}\n`,
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
      "test/checkpoint-store.test.ts",
    ],
    {
      ...process.env,
      AGENT_DOCK_TEST_S3_ENDPOINT: endpoint,
      AGENT_DOCK_TEST_S3_BUCKET: bucket,
      AGENT_DOCK_TEST_S3_ACCESS_KEY_ID: accessKeyId,
      AGENT_DOCK_TEST_S3_SECRET_ACCESS_KEY: secretAccessKey,
      AGENT_DOCK_TEST_S3_KEY_PREFIX: keyPrefix,
    },
    "S3 checkpoint compatibility test",
  );
} finally {
  if (containerStarted) {
    await run(
      docker.command,
      ["rm", "--force", containerName],
      process.env,
      "Disposable MinIO cleanup",
    ).catch(() => undefined);
  }
}
