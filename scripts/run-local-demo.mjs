import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const image = process.env.AGENT_DOCK_DOCKER_IMAGE ?? "agent-dock/pi-workspace:phase2";
const apiPort = process.env.AGENT_DOCK_DEMO_API_PORT ?? "3100";
const webPort = process.env.AGENT_DOCK_DEMO_WEB_PORT ?? "4173";
const managed = [];
let stopping = false;
let stoppingPromise;

function capture(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 256 * 1_024, timeout: 15_000 },
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
      // Try the next explicit local Docker CLI name.
    }
  }
  throw new Error(
    "Docker Engine is unavailable. Start Docker Desktop or set AGENT_DOCK_DOCKER_COMMAND.",
  );
}

function startManaged(name, command, args, environment) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const listeners = new Set();
  const record = (chunk, target) => {
    const text = chunk.toString("utf8");
    output = `${output}${text}`.slice(-64 * 1_024);
    target.write(text);
    for (const listener of listeners) listener(output);
  };
  child.stdout.on("data", (chunk) => record(chunk, process.stdout));
  child.stderr.on("data", (chunk) => record(chunk, process.stderr));
  const exit = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ name, code, signal }));
  });
  const processRecord = {
    name,
    child,
    exit,
    waitFor(pattern, timeoutMs = 30_000) {
      return new Promise((resolvePromise, rejectPromise) => {
        const inspect = (current) => {
          if (!pattern.test(current)) return;
          clearTimeout(timer);
          listeners.delete(inspect);
          resolvePromise();
        };
        const timer = setTimeout(() => {
          listeners.delete(inspect);
          rejectPromise(new Error(`${name} did not become ready within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        listeners.add(inspect);
        inspect(output);
      });
    },
  };
  managed.push(processRecord);
  return processRecord;
}

function signalManaged(processRecord, signal) {
  const pid = processRecord.child.pid;
  if (pid === undefined || processRecord.child.exitCode !== null) return;
  try {
    if (process.platform === "win32") processRecord.child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function stopManaged() {
  if (stoppingPromise !== undefined) return stoppingPromise;
  stopping = true;
  stoppingPromise = (async () => {
    for (const processRecord of managed) signalManaged(processRecord, "SIGTERM");
    const graceful = Promise.allSettled(managed.map((processRecord) => processRecord.exit));
    let forceTimer;
    const timeout = new Promise((resolvePromise) => {
      forceTimer = setTimeout(() => resolvePromise("timeout"), 10_000);
    });
    const outcome = await Promise.race([graceful.then(() => "graceful"), timeout]);
    clearTimeout(forceTimer);
    if (outcome === "timeout") {
      for (const processRecord of managed) signalManaged(processRecord, "SIGKILL");
      await Promise.allSettled(managed.map((processRecord) => processRecord.exit));
    }
  })();
  return stoppingPromise;
}

const closeAfterSignal = () => {
  void stopManaged().catch(() => {
    process.exitCode = 1;
  });
};
process.once("SIGINT", closeAfterSignal);
process.once("SIGTERM", closeAfterSignal);

try {
  const docker = await resolveDockerCommand();
  process.stdout.write(
    `${JSON.stringify({ dockerCommand: docker.command, engineVersion: docker.version, image })}\n`,
  );
  if (process.env.AGENT_DOCK_DEMO_SKIP_IMAGE_BUILD !== "1") {
    await run(docker.command, [
      "build",
      "--file",
      "packages/sandbox-supervisor/Dockerfile",
      "--tag",
      image,
      ".",
    ]);
  }
  await run(npmCommand, ["run", "build", "--workspace", "@agent-dock/web-ui"]);

  const environment = {
    ...process.env,
    AGENT_DOCK_DOCKER_COMMAND: docker.command,
    AGENT_DOCK_DOCKER_IMAGE: image,
    AGENT_DOCK_DEMO_API_PORT: apiPort,
    AGENT_DOCK_DEMO_WEB_PORT: webPort,
    AGENT_DOCK_DEMO_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
  };
  const backend = startManaged(
    "demo control plane",
    npmCommand,
    ["run", "demo", "--workspace", "@agent-dock/control-plane"],
    environment,
  );
  await backend.waitFor(/AgentDock demo control plane listening at /, 45_000);
  const web = startManaged(
    "web preview",
    npmCommand,
    ["run", "preview", "--workspace", "@agent-dock/web-ui"],
    environment,
  );
  await web.waitFor(/Local:\s+http:\/\//, 30_000);
  process.stdout.write(`\nAgentDock demo ready: http://127.0.0.1:${webPort}\n`);
  process.stdout.write("Press Ctrl+C to stop the web server and demo control plane.\n\n");

  const exited = await Promise.race([backend.exit, web.exit]);
  if (!stopping && (exited.code !== 0 || exited.signal !== "SIGTERM")) {
    throw new Error(
      `${exited.name} exited unexpectedly (code=${String(exited.code)}, signal=${String(exited.signal)})`,
    );
  }
} finally {
  await stopManaged();
}
