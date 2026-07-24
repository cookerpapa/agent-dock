import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image =
  process.env.AGENT_DOCK_CUBESANDBOX_TOOL_IMAGE ?? "agent-dock/cubesandbox-tool:experiment";
const containerName = `agent-dock-cubesandbox-template-check-${String(process.pid)}`;

function capture(command, args, timeout = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 4 * 1_024 * 1_024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${String(response.status)}: ${text}`);
  }
  return text.length === 0 ? undefined : JSON.parse(text);
}

async function waitUntilReady(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 204) return;
      lastError = new Error(`health returned ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Cube Tool service did not become ready: ${String(lastError)}`);
}

function operationEnvelope(activationId, operationId, operation) {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId,
    ...operation,
  };
}

let started = false;
try {
  await capture("docker", ["image", "inspect", image]);

  // Docker/runc counts RLIMIT_NPROC against every host process with uid 1000.
  // A real Cube microVM has its own guest uid namespace, so the image's normal
  // entrypoint uses the stricter 128-process limit. This local template check
  // substitutes only that limit and still starts the exact AgentDock service.
  await run("docker", [
    "run",
    "--detach",
    "--name",
    containerName,
    "--cpus",
    "1",
    "--memory",
    "768m",
    "--pids-limit",
    "128",
    "--publish",
    "127.0.0.1:0:49984",
    image,
    "/bin/bash",
    "-c",
    "ulimit -n 1024; exec setpriv --no-new-privs --reuid=1000 --regid=1000 --clear-groups /usr/local/bin/node /app/packages/tool-sandbox/src/cube-tool-service.ts",
  ]);
  started = true;

  const published = await capture("docker", ["port", containerName, "49984/tcp"]);
  const port = Number(published.slice(published.lastIndexOf(":") + 1));
  assert(Number.isInteger(port) && port > 0 && port <= 65_535, "Docker port was invalid");
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  await waitUntilReady(baseUrl);

  const evidence = await jsonRequest(baseUrl, "/v1/evidence");
  assert(evidence.uid === 1_000 && evidence.gid === 1_000, "Tool service was not uid/gid 1000");
  assert(evidence.noNewPrivileges === true, "Tool service allowed new privileges");
  assert(
    evidence.effectiveCapabilities === "0000000000000000",
    "Tool service retained Linux capabilities",
  );
  assert(
    evidence.readOnlyRootFilesystem === false,
    "Cube template unexpectedly reported a read-only guest rootfs",
  );
  assert(
    typeof evidence.imageRevision === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(evidence.imageRevision),
    "Cube image revision evidence was invalid",
  );

  const activationId = randomUUID();
  const toolchain = await jsonRequest(baseUrl, "/v1/initialize", {
    toolWorkerProtocolVersion: 1,
    type: "worker.initialize",
    activationId,
    environment: {
      environmentVersionId: randomUUID(),
      versionNumber: 1,
      profileKey: "agent-dock-fullstack",
      profileVersion: "1",
      imageRevision: evidence.imageRevision,
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: {
        schemaVersion: 1,
        setupCommands: [],
        verificationCommands: [
          {
            id: "git-worktree",
            command: "git status --short",
            cwd: ".",
            timeoutMs: 10_000,
            network: "none",
          },
        ],
      },
      recipeSha256: "5a851a442529ef2a092e5fb4f8f217703766a0142b267e4beb14fb1201aa1b6d",
    },
    workspaceSeed: { kind: "sample_java" },
  });
  const versions = new Map(toolchain.tools.map((tool) => [tool.name, tool.version]));
  assert(/^v24\./.test(versions.get("node") ?? ""), "Node 24 evidence was missing");
  assert(/version\s+"17(?:\.|")/.test(versions.get("java") ?? ""), "Java 17 evidence was missing");
  assert(/^Python 3\.11\./.test(versions.get("python") ?? ""), "Python 3.11 was missing");
  assert(/^git version 2\./.test(versions.get("git") ?? ""), "Git 2 evidence was missing");

  const source =
    "def counting_sort(values):\n" +
    "    if not values:\n" +
    "        return []\n" +
    "    low, high = min(values), max(values)\n" +
    "    counts = [0] * (high - low + 1)\n" +
    "    for value in values:\n" +
    "        counts[value - low] += 1\n" +
    "    return [value for value, count in enumerate(counts, low) for _ in range(count)]\n" +
    "\n" +
    "assert counting_sort([4, 2, 2, 8, 3, 3, 1]) == [1, 2, 2, 3, 3, 4, 8]\n" +
    "print('counting-sort-ok')\n";
  const write = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "file.write",
      path: "counting_sort.py",
      content: source,
    }),
  );
  assert(
    write.type === "tool_sandbox.operation_result" && write.operation === "file.write",
    "File write did not succeed",
  );

  const executed = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "bash.exec",
      command: "python3 counting_sort.py",
      cwd: "/workspace",
      timeoutMs: 10_000,
    }),
  );
  const output =
    executed.type === "tool_sandbox.operation_result" && executed.operation === "bash.exec"
      ? Buffer.from(executed.output, "base64").toString("utf8")
      : "";
  assert(executed.exitCode === 0 && output === "counting-sort-ok\n", "Python test failed");

  const envdProbeProgram =
    "const net=require('node:net');" +
    "const socket=net.createConnection({host:'127.0.0.1',port:49983});" +
    "const absent=()=>{socket.destroy();process.stdout.write('envd-absent')};" +
    "socket.setTimeout(1000,absent);" +
    "socket.once('error',absent);" +
    "socket.once('connect',()=>{socket.destroy();process.exit(91)});";
  const envdProbe = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "bash.exec",
      command: `node -e ${JSON.stringify(envdProbeProgram)}`,
      cwd: "/workspace",
      timeoutMs: 5_000,
    }),
  );
  const envdProbeOutput =
    envdProbe.type === "tool_sandbox.operation_result" && envdProbe.operation === "bash.exec"
      ? Buffer.from(envdProbe.output, "base64").toString("utf8")
      : "";
  assert(
    envdProbe.exitCode === 0 && envdProbeOutput === "envd-absent",
    "An unmediated envd service was reachable",
  );

  const escaped = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "file.read",
      path: "../etc/passwd",
    }),
  );
  assert(
    escaped.type === "tool_sandbox.operation_failed" &&
      escaped.code === "tool_path_escape" &&
      escaped.retryable === false,
    "Workspace path traversal was not rejected",
  );

  const captured = await jsonRequest(baseUrl, "/v1/capture", {
    activationId,
    requestId: randomUUID(),
  });
  assert(captured.type === "tool_sandbox.captured", "Workspace was not captured");
  const workspaceBytes = Buffer.from(captured.workspace.data, "base64");
  assert(
    workspaceBytes.byteLength === captured.workspace.sizeBytes,
    "Workspace checkpoint size evidence did not match",
  );
  assert(
    createHash("sha256").update(workspaceBytes).digest("hex") === captured.workspace.sha256,
    "Workspace checkpoint hash evidence did not match",
  );
  const manifest = JSON.parse(workspaceBytes.toString("utf8"));
  assert(
    manifest.files.some(
      (file) =>
        file.path === "counting_sort.py" &&
        Buffer.from(file.content, "base64").toString("utf8") === source,
    ),
    "Workspace checkpoint omitted the tested source file",
  );

  process.stdout.write(
    `${JSON.stringify({
      image,
      imageRevision: evidence.imageRevision,
      isolationValidated: false,
      templateService: {
        uid: evidence.uid,
        gid: evidence.gid,
        noNewPrivileges: evidence.noNewPrivileges,
        effectiveCapabilities: evidence.effectiveCapabilities,
      },
      toolchain: Object.fromEntries(versions),
      execution: { exitCode: executed.exitCode, output: output.trim() },
      unmediatedEnvdAbsent: true,
      pathTraversalRejected: true,
      checkpoint: {
        files: manifest.files.length,
        sizeBytes: captured.workspace.sizeBytes,
        sha256: captured.workspace.sha256,
      },
    })}\n`,
  );
} catch (error) {
  if (started) {
    const logs = await capture("docker", ["logs", "--tail", "200", containerName]).catch(() => "");
    if (logs.length > 0) process.stderr.write(`${logs}\n`);
  }
  throw error;
} finally {
  if (started) {
    await capture("docker", ["rm", "--force", containerName]).catch(() => undefined);
  }
}
