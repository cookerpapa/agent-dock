import {
  parseControlToSupervisorMessage,
  parseDockerSandboxWorkerInput,
  parseDockerSandboxWorkerOutput,
  type DockerSandboxWorkerOutput,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PiRpcEventPublisher, PiRpcTurnResult } from "./pi-rpc-turn-runner.ts";
import {
  PiRpcTurnCancelledError,
  PiRpcTurnError,
  type PiRpcCancellationSignal,
} from "./pi-rpc-turn-runner.ts";

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 90_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BUFFER_BYTES = 8 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 4_096;

export type DockerSandboxScenario = "java_repair" | "timeout";

export type DockerSandboxContainerIdentity = {
  containerName: string;
  commandId: string;
  sessionId: string;
  turnId: string;
};

export type DockerSandboxTurnRunnerOptions = {
  image: string;
  dockerCommand?: string;
  scenario?: DockerSandboxScenario;
  readyTimeoutMs?: number;
  executionTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
  onContainerReady?: (identity: DockerSandboxContainerIdentity) => Promise<void> | void;
};

type ExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Docker sandbox runner clock must return a valid Date");
  }
  return value;
}

function deferred<T>(): {
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new PiRpcTurnError("docker_timeout", `${label} timed out`, true));
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

function safeContainerSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return normalized.replace(/^[^a-z0-9]+/, "").slice(0, 24) || "run";
}

function containerName(command: ExecuteTurnCommandMessage, uniqueId: string): string {
  return `agent-dock-${safeContainerSegment(command.payload.commandId)}-${safeContainerSegment(uniqueId)}`.slice(
    0,
    63,
  );
}

export function buildDockerSandboxRunArguments(
  image: string,
  name: string,
  command: ExecuteTurnCommandMessage,
): readonly string[] {
  if (image.trim().length === 0) throw new TypeError("Docker sandbox image must not be empty");
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) {
    throw new TypeError("Docker sandbox container name is invalid");
  }
  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    name,
    "--label",
    "agent-dock.managed=true",
    "--label",
    `agent-dock.command-id=${command.payload.commandId}`,
    "--label",
    `agent-dock.session-id=${command.payload.sessionId}`,
    "--user",
    "1000:1000",
    "--read-only",
    "--network",
    "none",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "128",
    "--memory",
    "768m",
    "--cpus",
    "1.0",
    "--ulimit",
    "nofile=1024:1024",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    "--tmpfs",
    "/workspace:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700",
    "--workdir",
    "/workspace",
    "--stop-timeout",
    "5",
    image,
  ];
}

function sendLine(child: ChildProcessWithoutNullStreams, message: unknown): void {
  if (child.stdin.destroyed || !child.stdin.writable) {
    throw new PiRpcTurnError("docker_process_exit", "Docker sandbox input is unavailable", true);
  }
  if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
    throw new PiRpcTurnError("docker_backpressure", "Docker sandbox input is backpressured", true);
  }
}

function cancellationSignal(value: unknown): PiRpcCancellationSignal {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "agent-dock.turn-cancellation" ||
    !("reason" in value) ||
    (value.reason !== "user_request" &&
      value.reason !== "timeout" &&
      value.reason !== "lease_revoked" &&
      value.reason !== "shutdown") ||
    !("gracePeriodMs" in value) ||
    !Number.isSafeInteger(value.gracePeriodMs) ||
    (value.gracePeriodMs as number) < 0
  ) {
    throw new PiRpcTurnError(
      "invalid_cancellation",
      "Docker cancellation signal was invalid",
      false,
    );
  }
  return value as PiRpcCancellationSignal;
}

function executeDocker(
  dockerCommand: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      dockerCommand,
      [...args],
      { encoding: "utf8", maxBuffer: 256 * 1_024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : 1;
          resolvePromise({ code, stdout, stderr });
        } else {
          resolvePromise({ code: 0, stdout, stderr });
        }
      },
    ).once("error", rejectPromise);
  });
}

export class DockerSandboxTurnRunner {
  readonly #image: string;
  readonly #dockerCommand: string;
  readonly #scenario: DockerSandboxScenario;
  readonly #readyTimeoutMs: number;
  readonly #executionTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #onContainerReady:
    ((identity: DockerSandboxContainerIdentity) => Promise<void> | void) | undefined;

  constructor(options: DockerSandboxTurnRunnerOptions) {
    if (options.image.trim().length === 0) throw new TypeError("image must not be empty");
    this.#image = options.image;
    this.#dockerCommand = options.dockerCommand ?? "docker";
    this.#scenario = options.scenario ?? "java_repair";
    this.#readyTimeoutMs = positiveInteger(
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "readyTimeoutMs",
    );
    this.#executionTimeoutMs = positiveInteger(
      options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      "executionTimeoutMs",
    );
    this.#cleanupTimeoutMs = positiveInteger(
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      "cleanupTimeoutMs",
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#onContainerReady = options.onContainerReady;
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
    signal: AbortSignal,
  ): Promise<PiRpcTurnResult> {
    const name = containerName(command, this.#idGenerator());
    const identity: DockerSandboxContainerIdentity = {
      containerName: name,
      commandId: command.payload.commandId,
      sessionId: command.payload.sessionId,
      turnId: command.payload.turnId,
    };
    const child = spawn(
      this.#dockerCommand,
      [...buildDockerSandboxRunArguments(this.#image, name, command)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const ready = deferred<void>();
    const terminal = deferred<PiRpcTurnResult>();
    void ready.promise.catch(() => undefined);
    void terminal.promise.catch(() => undefined);
    let terminalSettled = false;
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = "";
    let messageChain = Promise.resolve();
    let protocolError: Error | undefined;
    let cancellationSent = false;
    let runSent = false;
    let removeAbortListener: (() => void) | undefined;

    const fail = (error: Error): void => {
      if (protocolError === undefined) protocolError = error;
      ready.reject(error);
      if (!terminalSettled) {
        terminalSettled = true;
        terminal.reject(error);
      }
    };

    const acknowledgeEvent = async (message: EventPublishMessage): Promise<void> => {
      await publishEvent(message);
      const acknowledgement = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "event.ack",
        payload: {
          sessionId: message.payload.event.sessionId,
          leaseId: message.payload.leaseId,
          fencingToken: message.payload.fencingToken,
          acknowledgedThroughSeq: message.payload.event.seq,
        },
      });
      if (acknowledgement.type !== "event.ack") {
        throw new PiRpcTurnError(
          "docker_protocol_error",
          "Docker event acknowledgement was invalid",
          false,
        );
      }
      sendLine(child, acknowledgement);
    };

    const handleMessage = async (message: DockerSandboxWorkerOutput): Promise<void> => {
      if (message.type === "sandbox.ready") {
        ready.resolve();
        return;
      }
      if (message.type === "event.publish") {
        await acknowledgeEvent(message);
        return;
      }
      if (terminalSettled) {
        throw new PiRpcTurnError(
          "docker_protocol_error",
          "Docker worker emitted multiple terminal results",
          false,
        );
      }
      terminalSettled = true;
      if (message.type === "sandbox.result") {
        terminal.resolve({ stopReason: message.stopReason });
      } else if (message.type === "sandbox.cancelled") {
        terminal.reject(new PiRpcTurnCancelledError(message.reason, message.forced));
      } else {
        terminal.reject(new PiRpcTurnError(message.code, message.message, message.retryable));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      if (stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
        fail(
          new PiRpcTurnError(
            "docker_protocol_error",
            "Docker worker output exceeded its buffer limit",
            false,
          ),
        );
        return;
      }
      let newline = stdoutBuffer.indexOf(0x0a);
      while (newline !== -1) {
        const line = stdoutBuffer.subarray(0, newline).toString("utf8").trim();
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (line.length > 0) {
          messageChain = messageChain
            .then(async () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line) as unknown;
              } catch {
                throw new PiRpcTurnError(
                  "docker_protocol_error",
                  "Docker worker emitted malformed JSONL",
                  false,
                );
              }
              await handleMessage(parseDockerSandboxWorkerOutput(parsed));
            })
            .catch((error: unknown) => {
              fail(error instanceof Error ? error : new Error(String(error)));
            });
        }
        newline = stdoutBuffer.indexOf(0x0a);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.once("error", () => {
      fail(new PiRpcTurnError("docker_start_failed", "Unable to start Docker sandbox", true));
    });

    const exitPromise = new Promise<ExitResult>((resolveExit) => {
      child.once("close", (code, closeSignal) => {
        const result = { code, signal: closeSignal };
        resolveExit(result);
        if (!terminalSettled) {
          fail(
            new PiRpcTurnError(
              "docker_process_exit",
              stderr.length > 0
                ? "Docker sandbox exited unexpectedly with diagnostic output"
                : "Docker sandbox exited unexpectedly",
              true,
            ),
          );
        }
      });
    });

    const sendCancellation = (): void => {
      if (!runSent || cancellationSent) return;
      try {
        const cancellation = cancellationSignal(signal.reason);
        cancellationSent = true;
        sendLine(
          child,
          parseDockerSandboxWorkerInput({
            sandboxProtocolVersion: 1,
            type: "sandbox.cancel",
            reason: cancellation.reason,
            gracePeriodMs: cancellation.gracePeriodMs,
          }),
        );
      } catch (error: unknown) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    let result: PiRpcTurnResult | undefined;
    let runError: unknown;
    let cleanupError: unknown;
    try {
      await withTimeout(ready.promise, this.#readyTimeoutMs, "Docker sandbox readiness");
      await this.#onContainerReady?.(identity);
      const runMessage = parseDockerSandboxWorkerInput({
        sandboxProtocolVersion: 1,
        type: "sandbox.run",
        command,
        runtime: { kind: "embedded_fake", scenario: this.#scenario },
        workspaceFixture: "java-repair",
      });
      sendLine(child, runMessage);
      runSent = true;
      signal.addEventListener("abort", sendCancellation, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", sendCancellation);
      if (signal.aborted) sendCancellation();
      result = await withTimeout(
        terminal.promise,
        this.#executionTimeoutMs,
        "Docker sandbox execution",
      );
    } catch (error: unknown) {
      runError = error;
    } finally {
      removeAbortListener?.();
      child.stdin.end();
      let exit: ExitResult | undefined;
      try {
        exit = await withTimeout(exitPromise, this.#cleanupTimeoutMs, "Docker sandbox exit");
      } catch {
        await this.#forceRemove(name, command.payload.commandId).catch((error: unknown) => {
          cleanupError = error;
        });
        exit = await withTimeout(
          exitPromise,
          this.#cleanupTimeoutMs,
          "Docker forced sandbox exit",
        ).catch(() => undefined);
      }
      await messageChain.catch(() => undefined);
      if (cleanupError === undefined) {
        await this.#forceRemove(name, command.payload.commandId).catch((error: unknown) => {
          cleanupError = error;
        });
      }
      if (
        cleanupError === undefined &&
        runError === undefined &&
        exit !== undefined &&
        (exit.code !== 0 || exit.signal !== null)
      ) {
        cleanupError = new PiRpcTurnError(
          "docker_process_exit",
          "Docker sandbox did not exit cleanly",
          true,
        );
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (protocolError !== undefined) throw protocolError;
    if (runError !== undefined) throw runError;
    if (result === undefined) {
      throw new PiRpcTurnError(
        "docker_protocol_error",
        "Docker sandbox ended without a result",
        false,
      );
    }
    return result;
  }

  async #forceRemove(name: string, commandId: string): Promise<void> {
    const identity = await executeDocker(
      this.#dockerCommand,
      [
        "inspect",
        "--format",
        '{{.Id}}|{{index .Config.Labels "agent-dock.managed"}}|{{index .Config.Labels "agent-dock.command-id"}}',
        name,
      ],
      this.#cleanupTimeoutMs,
    );
    if (identity.code !== 0) {
      if (/no such (?:object|container)/i.test(identity.stderr)) return;
      throw new PiRpcTurnError(
        "docker_cleanup_unverified",
        "Docker sandbox absence could not be verified",
        true,
      );
    }
    const [containerId, managed, owningCommandId] = identity.stdout.trim().split("|");
    if (!containerId || managed !== "true" || owningCommandId !== commandId) {
      throw new PiRpcTurnError(
        "docker_container_identity_mismatch",
        "Docker sandbox cleanup identity did not match",
        false,
      );
    }
    await executeDocker(
      this.#dockerCommand,
      ["rm", "--force", containerId],
      this.#cleanupTimeoutMs,
    ).catch(() => undefined);
    const remaining = await executeDocker(
      this.#dockerCommand,
      ["inspect", "--format", "{{.Id}}", containerId],
      this.#cleanupTimeoutMs,
    );
    if (remaining.code === 0 && remaining.stdout.trim().length > 0) {
      throw new PiRpcTurnError(
        "docker_container_alive",
        "Docker sandbox removal could not be confirmed",
        false,
      );
    }
    if (!/no such (?:object|container)/i.test(remaining.stderr)) {
      throw new PiRpcTurnError(
        "docker_cleanup_unverified",
        "Docker sandbox removal could not be verified",
        true,
      );
    }
  }
}
