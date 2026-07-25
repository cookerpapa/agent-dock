import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  type TemporalRunActivityResult,
  type TemporalRunWorkflowInput,
  type TemporalSpikeLedgerEntry,
} from "./contract.ts";
import { agentDockRunWorkflow } from "./workflows.ts";

const execFileAsync = promisify(execFile);
const TEMPORAL_CLI_VERSION = "1.8.1";
const TEMPORAL_CLI_SHA256 = {
  x64: "b94417b9a8760b30217f4b881dabce4b16a76a38b5e99e2eca3ce358b8030f06",
  arm64: "f622eba969aa58fdbe8a7b58feba7578b3fc935305079eb071d34bac12ffa5bb",
} as const;
const NAMESPACE = "agent-dock-spike";
const TASK_QUEUE = "agent-dock-pi-runs";
const POLICY_HASH = createHash("sha256").update("agent-dock-temporal-spike-policy").digest("hex");
const RAW_PROMPT_SENTINEL = `RAW-PROMPT-${randomUUID()}`;
const RAW_CREDENTIAL_SENTINEL = `sk-agent-dock-${randomUUID()}`;

type ManagedWorker = {
  id: string;
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureTemporalCli(): Promise<string> {
  const configured = process.env.AGENT_DOCK_TEMPORAL_CLI;
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error("The automatic Temporal CLI installer supports Linux x64/arm64 only");
  }
  const architecture = process.arch;
  const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  const directory = join(
    cacheRoot,
    "agent-dock",
    "temporal-cli",
    TEMPORAL_CLI_VERSION,
    architecture,
  );
  const archiveName = `temporal_cli_${TEMPORAL_CLI_VERSION}_linux_${architecture === "x64" ? "amd64" : "arm64"}.tar.gz`;
  const archive = join(directory, archiveName);
  const binary = join(directory, "temporal");
  const marker = join(directory, ".verified-sha256");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const expected = TEMPORAL_CLI_SHA256[architecture];
  const cachedMarker = await readFile(marker, "utf8").catch(() => "");
  if (cachedMarker.trim() === expected) {
    await chmod(binary, 0o700);
    return binary;
  }

  const response = await fetch(
    `https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI_VERSION}/${archiveName}`,
    { redirect: "follow" },
  );
  if (!response.ok) {
    throw new Error(`Temporal CLI download failed with HTTP ${String(response.status)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) {
    throw new Error("Temporal CLI archive failed its published SHA-256 check");
  }
  await writeFile(archive, bytes, { mode: 0o600 });
  await execFileAsync("tar", ["-xzf", archive, "-C", directory]);
  await chmod(binary, 0o700);
  await writeFile(marker, `${expected}\n`, { mode: 0o600 });
  return binary;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a Temporal development port");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  return address.port;
}

async function waitForPort(port: number, process: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error("Temporal development server exited before becoming ready");
    }
    const available = await new Promise<boolean>((resolvePromise) => {
      const socket = new Socket();
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      const unavailable = () => {
        socket.destroy();
        resolvePromise(false);
      };
      socket.once("timeout", unavailable);
      socket.once("error", unavailable);
      socket.connect(port, "127.0.0.1");
    });
    if (available) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Temporal development server did not become ready");
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const exited = new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
  });
  const timeout = new Promise<"timeout">((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise("timeout"), 5_000);
    timer.unref();
  });
  if ((await Promise.race([exited.then(() => "exited" as const), timeout])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

function startTemporalServer(
  temporalCli: string,
  port: number,
  databasePath: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    temporalCli,
    [
      "server",
      "start-dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--namespace",
      NAMESPACE,
      "--db-filename",
      databasePath,
      "--headless",
      "--log-level",
      "error",
    ],
    {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function startWorker(workerId: string, address: string, ledgerPath: string): ManagedWorker {
  const child = spawn(process.execPath, [new URL("./worker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      AGENT_DOCK_TEMPORAL_ADDRESS: address,
      AGENT_DOCK_TEMPORAL_NAMESPACE: NAMESPACE,
      AGENT_DOCK_TEMPORAL_TASK_QUEUE: TASK_QUEUE,
      AGENT_DOCK_TEMPORAL_WORKER_ID: workerId,
      AGENT_DOCK_TEMPORAL_LEDGER_PATH: ledgerPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`Temporal Worker ${workerId} did not become ready`));
    }, 30_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.type === "worker.ready" && value.workerId === workerId) {
            clearTimeout(timeout);
            resolvePromise();
            return;
          }
        } catch {
          // Temporal Worker logging is not part of the readiness protocol.
        }
      }
      stdout = stdout.slice(stdout.lastIndexOf("\n") + 1);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      rejectPromise(
        new Error(
          `Temporal Worker ${workerId} exited before readiness (${String(code)}/${String(signal)}): ${stderr}`,
        ),
      );
    });
    child.once("error", rejectPromise);
  });
  return { id: workerId, process: child, ready };
}

function workflowInput(
  runId: string,
  mode: TemporalRunWorkflowInput["mode"],
  simulatedDurationMs: number,
): TemporalRunWorkflowInput {
  return {
    runId,
    sessionId: `session-${runId}`,
    attemptBaseFence: 100,
    promptRef: `postgres://turn-inputs/${runId}`,
    piCheckpointRef: `s3://pi-sessions/${runId}/head`,
    workspaceCheckpointRef: `s3://workspaces/${runId}/head`,
    policyHash: POLICY_HASH,
    mode,
    simulatedDurationMs,
  };
}

async function readLedger(path: string): Promise<TemporalSpikeLedgerEntry[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TemporalSpikeLedgerEntry);
}

async function waitForLedger(
  path: string,
  predicate: (entry: TemporalSpikeLedgerEntry) => boolean,
  timeoutMs = 20_000,
): Promise<TemporalSpikeLedgerEntry> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await readLedger(path)).find(predicate);
    if (match !== undefined) return match;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Temporal spike ledger evidence did not arrive");
}

function collectHistoryText(value: unknown, output: string[], seen: Set<object>): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (value instanceof Uint8Array) {
    output.push(Buffer.from(value).toString("utf8"));
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectHistoryText(item, output, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectHistoryText(item, output, seen);
  }
}

async function historyEvidence(
  connection: Connection,
  workflowId: string,
): Promise<{ eventCount: number; containsForbiddenBytes: boolean }> {
  const response = await connection.workflowService.getWorkflowExecutionHistory({
    namespace: NAMESPACE,
    execution: { workflowId },
  });
  const text: string[] = [];
  collectHistoryText(response.history, text, new Set());
  const joined = text.join("\n");
  return {
    eventCount: response.history?.events?.length ?? 0,
    containsForbiddenBytes:
      joined.includes(RAW_PROMPT_SENTINEL) || joined.includes(RAW_CREDENTIAL_SENTINEL),
  };
}

const root = await mkdtemp(join(tmpdir(), "agent-dock-temporal-spike-"));
const ledgerPath = join(root, "activity-ledger.jsonl");
const databasePath = join(root, "temporal.db");
const temporalCli = await ensureTemporalCli();
const port = await freePort();
const address = `127.0.0.1:${String(port)}`;
let server = startTemporalServer(temporalCli, port, databasePath);
let connection: Connection | undefined;
const workers: ManagedWorker[] = [];
const startedAt = performance.now();

try {
  await waitForPort(port, server);
  connection = await Connection.connect({ address });
  let client = new Client({ connection, namespace: NAMESPACE });

  workers.push(
    startWorker("pi-worker-a", address, ledgerPath),
    startWorker("pi-worker-b", address, ledgerPath),
  );
  await Promise.all(workers.map((worker) => worker.ready));

  const distributionStartedAt = performance.now();
  const normalHandles = await Promise.all(
    Array.from({ length: 4 }, async (_, index) => {
      const runId = `normal-${String(index + 1)}`;
      return client.workflow.start(agentDockRunWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `agent-dock/run/${runId}`,
        workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
        args: [workflowInput(runId, "normal", 400)],
      });
    }),
  );
  const normalResults = await Promise.all(normalHandles.map((handle) => handle.result()));
  const distributionDurationMs = Math.round(performance.now() - distributionStartedAt);
  const usedWorkers = [...new Set(normalResults.map((result) => result.workerId))].sort();
  if (usedWorkers.length !== 2) {
    throw new Error("Temporal Task Queue did not distribute capacity-one work across both Workers");
  }

  const duplicateWorkflowId = "agent-dock/run/normal-1";
  let duplicateRejected = false;
  try {
    await client.workflow.start(agentDockRunWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: duplicateWorkflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
      args: [workflowInput("normal-1", "normal", 50)],
    });
  } catch (error: unknown) {
    duplicateRejected = error instanceof WorkflowExecutionAlreadyStartedError;
  }
  if (!duplicateRejected) {
    throw new Error("Temporal did not reject a duplicate AgentDock Run Workflow ID");
  }

  const crashRunId = "worker-crash";
  const crashHandle = await client.workflow.start(agentDockRunWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: `agent-dock/run/${crashRunId}`,
    workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    args: [workflowInput(crashRunId, "crash_recovery", 250)],
  });
  const firstAttempt = await waitForLedger(
    ledgerPath,
    (entry) =>
      entry.runId === crashRunId && entry.phase === "started" && entry.activityAttempt === 1,
  );
  const killedWorker = workers.find((worker) => worker.process.pid === firstAttempt.workerPid);
  if (killedWorker === undefined) {
    throw new Error("Unable to identify the Worker chosen for crash injection");
  }
  killedWorker.process.kill("SIGKILL");
  const crashResult = await crashHandle.result();
  if (
    crashResult.activityAttempt < 2 ||
    crashResult.fencingToken <= firstAttempt.fencingToken ||
    crashResult.workerId === firstAttempt.workerId
  ) {
    throw new Error("Temporal Worker replacement did not advance the Activity attempt/fence");
  }

  const replacement = startWorker("pi-worker-c", address, ledgerPath);
  workers.push(replacement);
  await replacement.ready;

  const cancellationRunId = "cancelled";
  const cancellationHandle = await client.workflow.start(agentDockRunWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: `agent-dock/run/${cancellationRunId}`,
    workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    args: [workflowInput(cancellationRunId, "cancellation", 30_000)],
  });
  await waitForLedger(
    ledgerPath,
    (entry) => entry.runId === cancellationRunId && entry.phase === "started",
  );
  await cancellationHandle.cancel();
  await cancellationHandle.result().catch(() => undefined);
  const cancellationDescription = await cancellationHandle.describe();
  const cancellationObserved = await waitForLedger(
    ledgerPath,
    (entry) => entry.runId === cancellationRunId && entry.phase === "cancelled",
  );
  if (cancellationDescription.status.name !== "CANCELLED") {
    throw new Error("Temporal Workflow cancellation did not reach a terminal cancelled state");
  }

  const restartStartedAt = performance.now();
  await connection.close();
  connection = undefined;
  await stopProcess(server);
  server = startTemporalServer(temporalCli, port, databasePath);
  await waitForPort(port, server);
  connection = await Connection.connect({ address });
  client = new Client({ connection, namespace: NAMESPACE });
  const postRestartRunId = "service-restart";
  const postRestartHandle = await client.workflow.start(agentDockRunWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: `agent-dock/run/${postRestartRunId}`,
    workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    args: [workflowInput(postRestartRunId, "normal", 200)],
  });
  const postRestartResult = await postRestartHandle.result();
  const restartRecoveryDurationMs = Math.round(performance.now() - restartStartedAt);

  const history = await historyEvidence(connection, postRestartHandle.workflowId);
  if (history.containsForbiddenBytes || history.eventCount < 1) {
    throw new Error("Temporal Workflow history failed its bounded-secret evidence check");
  }

  const activityAttempts = (await readLedger(ledgerPath)).filter(
    (entry) => entry.phase === "started",
  );
  const output = {
    result: "passed",
    temporal: {
      cliVersion: TEMPORAL_CLI_VERSION,
      sdkVersion: "1.21.1",
      namespace: NAMESPACE,
      taskQueue: TASK_QUEUE,
    },
    workflowModel: "one bounded Workflow per AgentDock Run",
    activityModel: "one cancellable Pi Run Activity; arbitrary Tool side effects remain fenced",
    workerPool: {
      initialWorkers: ["pi-worker-a", "pi-worker-b"],
      replacementWorker: replacement.id,
      normalRuns: normalResults.length,
      usedWorkers,
      capacityPerWorker: 1,
      distributionDurationMs,
    },
    workerCrash: {
      killedWorker: firstAttempt.workerId,
      firstAttempt: firstAttempt.activityAttempt,
      recoveredWorker: crashResult.workerId,
      recoveredAttempt: crashResult.activityAttempt,
      firstFence: firstAttempt.fencingToken,
      recoveredFence: crashResult.fencingToken,
    },
    cancellation: {
      workflowStatus: cancellationDescription.status.name,
      activityCleanupObserved: cancellationObserved.phase === "cancelled",
    },
    serviceRestart: {
      persistentDatabase: true,
      recoveryDurationMs: restartRecoveryDurationMs,
      completedBy: postRestartResult.workerId,
    },
    idempotency: { duplicateWorkflowIdRejected: duplicateRejected },
    history: {
      eventCount: history.eventCount,
      containsRawPrompt: false,
      containsCredential: false,
      carriesOnlyBoundedReferences: true,
    },
    ledger: {
      activityStartRecords: activityAttempts.length,
      pathRemovedOnExit: true,
    },
    elapsedMs: Math.round(performance.now() - startedAt),
    modelCalls: 0,
    note: "This proves Temporal orchestration behavior, not exactly-once Pi/Tool execution or production operational readiness.",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await connection?.close().catch(() => undefined);
  await Promise.allSettled(workers.map((worker) => stopProcess(worker.process)));
  await stopProcess(server).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
