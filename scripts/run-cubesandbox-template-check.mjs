import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

let currentAuthority;
async function jsonRequest(baseUrl, path, body, authority = currentAuthority) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(authority === undefined
        ? {}
        : {
            "x-agent-dock-handoff-secret": authority.handoffSecret,
            "x-agent-dock-fencing-token": String(authority.fencingToken),
            "x-agent-dock-binding-sha256": authority.bindingSha256,
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${String(response.status)}: ${text}`);
  }
  return text.length === 0 ? undefined : JSON.parse(text);
}

async function requestStatus(baseUrl, path, body, authority) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-dock-handoff-secret": authority.handoffSecret,
      "x-agent-dock-fencing-token": String(authority.fencingToken),
      "x-agent-dock-binding-sha256": authority.bindingSha256,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  return response.status;
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

const templateStepContextSha256 = createHash("sha256")
  .update("agent-dock-template-check-step-context", "utf8")
  .digest("hex");

function operationEnvelope(activationId, operationId, operation) {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId,
    stepContextSha256: templateStepContextSha256,
    ...operation,
  };
}

function bashOutput(response) {
  if (response.type !== "tool_sandbox.operation_result" || response.operation !== "bash.exec") {
    return "";
  }
  return Buffer.concat(
    response.outputChunks.map((chunk) => Buffer.from(chunk.data, "base64")),
  ).toString("utf8");
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
    "ulimit -n 1024; exec setpriv --no-new-privs /usr/local/bin/node /app/packages/tool-sandbox/src/cube-tool-service.ts",
  ]);
  started = true;

  const published = await capture("docker", ["port", containerName, "49984/tcp"]);
  const port = Number(published.slice(published.lastIndexOf(":") + 1));
  assert(Number.isInteger(port) && port > 0 && port <= 65_535, "Docker port was invalid");
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  await waitUntilReady(baseUrl);

  const evidence = await jsonRequest(baseUrl, "/v1/evidence");
  assert(evidence.uid === 1_000 && evidence.gid === 1_000, "Tool service was not uid/gid 1000");
  assert(
    evidence.supervisorUid === 0 && evidence.supervisorGid === 0,
    "Cube handoff supervisor was not root-owned",
  );
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
  // A fresh VM created from an immutable base template receives its durable
  // Workspace through the Cube Volume Plugin before the trusted Manager
  // initializes the Tool Worker. Exercise that cold-attach path explicitly;
  // warm rebind below covers the same attach contract after a sealed handoff.
  await capture("docker", [
    "exec",
    "--user",
    "1000:1000",
    containerName,
    "sh",
    "-c",
    "printf 'template check\\n' > /workspace/README.txt && test ! -e /workspace/.git",
  ]);

  const activationId = randomUUID();
  currentAuthority = {
    handoffSecret: `adch_${randomBytes(32).toString("base64url")}`,
    fencingToken: 7,
    bindingSha256: createHash("sha256").update("template-check-binding").digest("hex"),
  };
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
            id: "workspace-root",
            command: 'test "$PWD" = /workspace && test -w .',
            cwd: ".",
            timeoutMs: 10_000,
            network: "none",
          },
        ],
      },
      recipeSha256: "2d6c5260fe7bc3901e454ff93106dc5ed263d6edbbabf7bafdf852021289e5ba",
    },
    workspaceSeed: { kind: "sample_java" },
    workspaceAttach: { recipeCommands: [] },
  });
  const versions = new Map(toolchain.tools.map((tool) => [tool.name, tool.version]));
  assert(/^v24\./.test(versions.get("node") ?? ""), "Node 24 evidence was missing");
  assert(/version\s+"17(?:\.|")/.test(versions.get("java") ?? ""), "Java 17 evidence was missing");
  assert(/^Python 3\.11\./.test(versions.get("python") ?? ""), "Python 3.11 was missing");
  assert(/^git version 2\./.test(versions.get("git") ?? ""), "Git 2 evidence was missing");

  const pythonTls = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "bash.exec",
      command: 'python3 -c "import ssl; print(ssl.OPENSSL_VERSION)"',
      cwd: "/workspace",
      timeoutMs: 10_000,
    }),
  );
  const pythonTlsOutput = bashOutput(pythonTls);
  assert(
    pythonTls.exitCode === 0 && /^OpenSSL 3\./.test(pythonTlsOutput),
    "Python TLS support was not usable inside the Cube template",
  );

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
  const output = bashOutput(executed);
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
      command: `test ! -e /usr/bin/envd && node -e ${JSON.stringify(envdProbeProgram)}`,
      cwd: "/workspace",
      timeoutMs: 5_000,
    }),
  );
  const envdProbeOutput = bashOutput(envdProbe);
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

  const background = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "bash.exec",
      command: "sleep 300 >/dev/null 2>&1 & echo $!",
      cwd: "/workspace",
      timeoutMs: 5_000,
    }),
  );
  assert(background.exitCode === 0, "Background-process fixture did not start");
  const backgroundPid = Number(bashOutput(background).trim());
  assert(Number.isSafeInteger(backgroundPid) && backgroundPid > 1, "Background PID was invalid");
  const previousAuthority = currentAuthority;
  const recoveryAuthority = {
    ...previousAuthority,
    handoffSecret: `adch_${randomBytes(32).toString("base64url")}`,
  };
  const checkpointed = await jsonRequest(
    baseUrl,
    "/v1/checkpoint",
    { recoverySecret: recoveryAuthority.handoffSecret },
    previousAuthority,
  );
  assert(
    checkpointed.sealed === true &&
      Array.isArray(checkpointed.frozenToolProcesses) &&
      checkpointed.frozenToolProcesses.some((process) => process.pid === backgroundPid) &&
      checkpointed.files.some((file) => file.path === "counting_sort.py"),
    "Cube guest did not prepare a quiescent Workspace checkpoint",
  );
  const staleWhileSealed = await requestStatus(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "file.read",
      path: "counting_sort.py",
    }),
    previousAuthority,
  );
  assert(staleWhileSealed === 403, "The pre-checkpoint authority survived rotation");
  const completed = await jsonRequest(baseUrl, "/v1/checkpoint/complete", {}, recoveryAuthority);
  assert(
    completed.completed === true &&
      completed.resumedToolProcesses === checkpointed.frozenToolProcesses.length,
    "Cube guest did not resume the checkpointed process boundary",
  );

  const nextAuthority = {
    ...recoveryAuthority,
    handoffSecret: `adch_${randomBytes(32).toString("base64url")}`,
    fencingToken: recoveryAuthority.fencingToken + 1,
  };
  const rebound = await jsonRequest(
    baseUrl,
    "/v1/rebind",
    {
      activationId,
      handoffSecret: nextAuthority.handoffSecret,
      fencingToken: nextAuthority.fencingToken,
      bindingSha256: nextAuthority.bindingSha256,
    },
    recoveryAuthority,
  );
  assert(
    rebound.rebound === true && rebound.fencingToken === nextAuthority.fencingToken,
    "Cube guest did not accept the higher-fence handoff",
  );
  currentAuthority = nextAuthority;
  const staleAfterRebind = await requestStatus(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "file.read",
      path: "counting_sort.py",
    }),
    recoveryAuthority,
  );
  assert(staleAfterRebind === 403, "The old Cube handoff authority survived rebind");
  const preserved = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "file.read",
      path: "counting_sort.py",
    }),
  );
  assert(
    preserved.type === "tool_sandbox.operation_result" &&
      Buffer.from(preserved.content, "base64").toString("utf8") === source,
    "Rebound Tool Worker did not attach the preserved Workspace",
  );
  const backgroundPreserved = await jsonRequest(
    baseUrl,
    "/v1/operation",
    operationEnvelope(activationId, randomUUID(), {
      operation: "bash.exec",
      command: `kill -0 ${String(backgroundPid)} && printf background-alive`,
      cwd: "/workspace",
      timeoutMs: 5_000,
    }),
  );
  assert(
    backgroundPreserved.exitCode === 0 && bashOutput(backgroundPreserved) === "background-alive",
    "Session background process did not survive checkpoint and rebind",
  );

  process.stdout.write(
    `${JSON.stringify({
      image,
      imageRevision: evidence.imageRevision,
      isolationValidated: false,
      templateService: {
        uid: evidence.uid,
        gid: evidence.gid,
        supervisorUid: evidence.supervisorUid,
        supervisorGid: evidence.supervisorGid,
        noNewPrivileges: evidence.noNewPrivileges,
        effectiveCapabilities: evidence.effectiveCapabilities,
      },
      toolchain: Object.fromEntries(versions),
      execution: { exitCode: executed.exitCode, output: output.trim() },
      coldWorkspaceAttach: true,
      unmediatedEnvdAbsent: true,
      pathTraversalRejected: true,
      sessionHandoff: {
        previousFence: previousAuthority.fencingToken,
        currentFence: nextAuthority.fencingToken,
        frozenToolProcesses: checkpointed.frozenToolProcesses.length,
        resumedToolProcesses: completed.resumedToolProcesses,
        backgroundProcessPreserved: true,
        staleAuthorityRejected: true,
      },
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
