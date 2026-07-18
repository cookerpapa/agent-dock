import {
  createAgentDockEventFactory,
  type AgentDockEvent,
  type EventAckMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { InMemoryEventSpool, PiRpcEventAdapter } from "@agent-dock/sandbox-supervisor";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  resolve: (message: JsonRecord) => void;
  reject: (error: Error) => void;
};

type ExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const EXPECTED_CONFIRM_TITLE = "AgentDock compatibility check";
const EXPECTED_NOTIFICATION = "AgentDock extension UI round trip succeeded.";
const WIRE_COMMAND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WIRE_LEASE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, description: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${description} was not a JSON object`);
  }
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new Error(`${description} was not a string`);
  }
  return value;
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function sanitizedEnvironment(agentDir: string): NodeJS.ProcessEnv {
  const sensitiveName = /(api[_-]?key|token|secret|password|credential|auth)/i;
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (!sensitiveName.test(name)) {
      environment[name] = value;
    }
  }

  environment.PI_CODING_AGENT_DIR = agentDir;
  environment.PI_OFFLINE = "1";
  return environment;
}

function sendLine(child: ChildProcessWithoutNullStreams, message: JsonRecord): void {
  if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
    throw new Error("Pi RPC stdin applied backpressure during the small compatibility exchange");
  }
}

function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      const code = isRecord(error) ? error.code : undefined;
      if (code !== "ESRCH") {
        throw error;
      }
      return;
    }
  }

  child.kill(signal);
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  exitPromise: Promise<ExitResult>,
): Promise<{ exit: ExitResult; forced: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exit: await exitPromise, forced: false };
  }

  child.stdin.end();
  try {
    return {
      exit: await withTimeout(exitPromise, "clean Pi shutdown", SHUTDOWN_TIMEOUT_MS),
      forced: false,
    };
  } catch {
    terminateProcessGroup(child, "SIGTERM");
    try {
      return {
        exit: await withTimeout(exitPromise, "Pi SIGTERM shutdown", SHUTDOWN_TIMEOUT_MS),
        forced: true,
      };
    } catch {
      terminateProcessGroup(child, "SIGKILL");
      return {
        exit: await withTimeout(exitPromise, "Pi SIGKILL shutdown", SHUTDOWN_TIMEOUT_MS),
        forced: true,
      };
    }
  }
}

async function main(): Promise<void> {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const spikeDirectory = resolve(sourceDirectory, "..");
  const repositoryDirectory = resolve(spikeDirectory, "../..");
  const extensionPath = resolve(spikeDirectory, "extension/cloud-check.ts");
  const installedPiCandidates = [
    resolve(spikeDirectory, "node_modules/.bin/pi"),
    resolve(repositoryDirectory, "node_modules/.bin/pi"),
  ];
  const installedPi = installedPiCandidates.find((candidate) => existsSync(candidate));
  const piCommand = process.env.PI_COMMAND ?? installedPi ?? "pi";
  const isolatedAgentDir = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-"));
  const pendingRequests = new Map<string, PendingRequest>();
  const agentDockEvents: AgentDockEvent[] = [];
  const eventFactory = createAgentDockEventFactory({
    sessionId: "compat-session",
    turnId: "compat-turn",
    agentId: "root",
  });
  const piEventAdapter = new PiRpcEventAdapter(eventFactory);
  const eventSpool = new InMemoryEventSpool({
    sessionId: "compat-session",
    leaseId: WIRE_LEASE_ID,
    fencingToken: 1,
  });
  const publishEvent = (event: AgentDockEvent): void => {
    const message: EventPublishMessage = {
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "event.publish",
      payload: {
        leaseId: WIRE_LEASE_ID,
        fencingToken: 1,
        commandId: WIRE_COMMAND_ID,
        event,
      },
    };
    eventSpool.append(message);
    agentDockEvents.push(event);
  };
  let notification: ReturnType<typeof createDeferred<AgentDockEvent>> | undefined;
  let fatalProtocolError: Error | undefined;
  let requestNumber = 0;
  let stdoutBuffer = Buffer.alloc(0);
  let stderr = "";
  let confirmRequestObserved = false;
  const debugEnabled = process.env.AGENT_DOCK_SPIKE_DEBUG === "1";

  const debug = (message: string): void => {
    if (debugEnabled) {
      process.stderr.write(`[pi-spike] ${message}\n`);
    }
  };

  const child = spawn(
    piCommand,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-tools",
      "--extension",
      extensionPath,
    ],
    {
      cwd: spikeDirectory,
      detached: process.platform !== "win32",
      env: sanitizedEnvironment(isolatedAgentDir),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const exitPromise = new Promise<ExitResult>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });

  const failProtocol = (error: Error): void => {
    if (fatalProtocolError !== undefined) {
      return;
    }
    fatalProtocolError = error;
    notification?.reject(error);
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
  };

  const handleMessage = (message: JsonRecord): void => {
    debug(`stdout message type=${String(message.type)} id=${String(message.id ?? "-")}`);
    if (message.type === "response") {
      const id = typeof message.id === "string" ? message.id : undefined;
      if (id !== undefined) {
        const pending = pendingRequests.get(id);
        if (pending !== undefined) {
          pendingRequests.delete(id);
          if (message.success === true) {
            pending.resolve(message);
          } else {
            pending.reject(new Error(`Pi RPC request ${id} failed: ${String(message.error)}`));
          }
        }
      }
      return;
    }

    if (message.type === "extension_error") {
      failProtocol(new Error(`Pi extension failed: ${String(message.error)}`));
      return;
    }

    if (message.type !== "extension_ui_request") {
      return;
    }

    const adapted = piEventAdapter.adaptOutput(message);
    if (adapted.kind !== "mapped") {
      failProtocol(new Error(`Pi UI event was not mapped: ${adapted.kind} (${adapted.reason})`));
      return;
    }
    publishEvent(adapted.event);

    if (message.method === "confirm") {
      const title = requireString(message.title, "confirm request title");
      if (title !== EXPECTED_CONFIRM_TITLE) {
        failProtocol(new Error(`Unexpected confirm title: ${title}`));
        return;
      }
      if (adapted.event.type !== "approval.requested" || adapted.event.payload.kind !== "confirm") {
        failProtocol(new Error("Pi confirm did not map to an AgentDock confirm approval"));
        return;
      }
      confirmRequestObserved = true;
      const resolution = piEventAdapter.resolveApproval({
        approvalId: adapted.event.payload.approvalId,
        outcome: "approved",
      });
      publishEvent(resolution.event);
      sendLine(child, { ...resolution.piResponse });
      return;
    }

    if (message.method === "notify") {
      const text = requireString(message.message, "notification message");
      if (
        text === EXPECTED_NOTIFICATION &&
        message.notifyType === "info" &&
        adapted.event.type === "ui.notification"
      ) {
        notification?.resolve(adapted.event);
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newline = stdoutBuffer.indexOf(0x0a);

    while (newline !== -1) {
      const line = stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (line.length > 0) {
        try {
          handleMessage(requireRecord(JSON.parse(line), "Pi RPC output"));
        } catch (error: unknown) {
          failProtocol(error instanceof Error ? error : new Error(String(error)));
        }
      }
      newline = stdoutBuffer.indexOf(0x0a);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });

  child.stdin.on("finish", () => debug("stdin finished"));
  child.stdin.on("close", () => debug("stdin closed"));

  child.once("error", (error) => {
    failProtocol(new Error(`Unable to start Pi RPC using ${piCommand}: ${error.message}`));
  });

  child.once("exit", (code, signal) => {
    debug(`process exited code=${String(code)} signal=${String(signal)}`);
  });

  // `exit` may be emitted before buffered stdout has been delivered. Only
  // declare requests lost on `close`, when all stdio streams are closed.
  child.once("close", (code, signal) => {
    debug(`process closed code=${String(code)} signal=${String(signal)}`);
    if (pendingRequests.size > 0) {
      const pendingIds = [...pendingRequests.keys()].join(", ");
      failProtocol(
        new Error(
          `Pi RPC exited before completing requests ${pendingIds} (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    }
  });

  const request = (type: string, fields: JsonRecord = {}): Promise<JsonRecord> => {
    if (fatalProtocolError !== undefined) {
      return Promise.reject(fatalProtocolError);
    }
    requestNumber += 1;
    const id = `spike-${requestNumber}`;
    const deferred = createDeferred<JsonRecord>();
    pendingRequests.set(id, deferred);
    sendLine(child, { id, type, ...fields });
    return withTimeout(deferred.promise, `Pi RPC ${type}`);
  };

  let shutdown: { exit: ExitResult; forced: boolean } | undefined;
  try {
    const commandsResponse = await request("get_commands");
    const data = requireRecord(commandsResponse.data, "get_commands response data");
    if (!Array.isArray(data.commands)) {
      throw new Error("get_commands response did not contain a commands array");
    }

    const cloudCheck = data.commands.find(
      (command) =>
        isRecord(command) && command.name === "cloud-check" && command.source === "extension",
    );
    if (cloudCheck === undefined) {
      throw new Error("Pi did not discover the /cloud-check extension command");
    }

    notification = createDeferred<AgentDockEvent>();
    // Prevent a process-exit rejection from being reported as unhandled before
    // the Promise.all below attaches its semantic waiter.
    void notification.promise.catch(() => undefined);
    const promptPromise = request("prompt", { message: "/cloud-check" });
    await Promise.all([promptPromise, withTimeout(notification.promise, "extension notification")]);

    if (!confirmRequestObserved) {
      throw new Error("The extension completed without an observable confirm round trip");
    }
    const expectedEventTypes = ["approval.requested", "approval.resolved", "ui.notification"];
    const actualEventTypes = agentDockEvents.map((event) => event.type);
    if (JSON.stringify(actualEventTypes) !== JSON.stringify(expectedEventTypes)) {
      throw new Error(`Unexpected AgentDock event sequence: ${actualEventTypes.join(", ")}`);
    }
    if (!agentDockEvents.every((event, index) => event.seq === index + 1)) {
      throw new Error("AgentDock event sequence numbers were not monotonic");
    }
    if (piEventAdapter.pendingApprovalCount !== 0) {
      throw new Error("The Pi adapter retained a resolved approval");
    }

    const replayedAfterDisconnect = eventSpool.replayAfter(0);
    if (
      replayedAfterDisconnect.length !== 3 ||
      !replayedAfterDisconnect.every((message, index) => message.payload.event.seq === index + 1)
    ) {
      throw new Error(
        "The event spool did not replay the complete ordered suffix after disconnect",
      );
    }

    const createEventAck = (acknowledgedThroughSeq: number): EventAckMessage => ({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "event.ack",
      payload: {
        sessionId: "compat-session",
        leaseId: WIRE_LEASE_ID,
        fencingToken: 1,
        acknowledgedThroughSeq,
      },
    });
    const firstAck = eventSpool.acknowledge(createEventAck(2));
    const replayedAfterAck = eventSpool.replayAfter(2);
    if (
      firstAck.removedCount !== 2 ||
      replayedAfterAck.length !== 1 ||
      replayedAfterAck[0]?.payload.event.seq !== 3
    ) {
      throw new Error("Cumulative event ACK did not retain exactly the unacknowledged suffix");
    }
    eventSpool.acknowledge(createEventAck(3));
    if (eventSpool.pendingCount !== 0) {
      throw new Error("The event spool retained events after the final durable ACK");
    }

    await request("abort");
    shutdown = await stopChild(child, exitPromise);

    if (shutdown.forced || shutdown.exit.code !== 0 || shutdown.exit.signal !== null) {
      throw new Error(
        `Pi did not exit cleanly (forced=${shutdown.forced}, code=${String(shutdown.exit.code)}, signal=${String(shutdown.exit.signal)})`,
      );
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          status: "passed",
          piCommand,
          checks: {
            commandDiscovered: true,
            confirmRoundTrip: true,
            notificationObserved: true,
            eventEnvelopeMapped: true,
            wireProtocolValidated: true,
            cumulativeAckAndReplay: true,
            spoolDrained: true,
            abortAcknowledged: true,
            cleanExit: true,
          },
          agentDockEvents: agentDockEvents.map((event) => ({ seq: event.seq, type: event.type })),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}${stderr.length > 0 ? `\nPi stderr:\n${stderr}` : ""}`);
  } finally {
    if (shutdown === undefined) {
      await stopChild(child, exitPromise).catch(() => undefined);
    }
    await rm(isolatedAgentDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
