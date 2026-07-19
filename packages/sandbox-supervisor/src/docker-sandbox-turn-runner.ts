import {
  parseControlToSupervisorMessage,
  parseDockerSandboxWorkerInput,
  parseDockerSandboxWorkerOutput,
  type DockerSandboxCheckpointPublishMessage,
  type DockerSandboxWorkerOutput,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  DOCKER_SANDBOX_LABELS,
  DockerSandboxAssignmentInventory,
  validateSandboxRuntimeIdentity,
  type SandboxRuntimeIdentity,
} from "./docker-sandbox-assignment-inventory.ts";
import type { PiRpcEventPublisher, PiRpcTurnResult } from "./pi-rpc-turn-runner.ts";
import {
  PiRpcTurnCancelledError,
  PiRpcTurnError,
  type PiRpcCancellationSignal,
} from "./pi-rpc-turn-runner.ts";
import {
  decodeSettledCheckpoint,
  encodeSettledCheckpoint,
  validateLoadedCheckpoint,
  type LoadedSandboxCheckpoint,
  type SandboxCheckpointStore,
} from "./sandbox-checkpoint.ts";
import { validateWorkspaceSnapshot } from "./workspace-snapshot.ts";

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 90_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BUFFER_BYTES = 8 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 4_096;

export type DockerSandboxScenario = "java_repair" | "java_followup" | "timeout";

export type DockerSandboxScenarioContext = {
  command: ExecuteTurnCommandMessage;
  restoring: boolean;
};

export type DockerSandboxScenarioResolver = (
  context: DockerSandboxScenarioContext,
) => DockerSandboxScenario;

export type DockerSandboxContainerIdentity = SandboxRuntimeIdentity & {
  containerName: string;
  commandId: string;
  sessionId: string;
  turnId: string;
  leaseId: string;
  fencingToken: number;
};

export type DockerSandboxTurnRunnerOptions = {
  image: string;
  runtimeIdentity: SandboxRuntimeIdentity;
  dockerCommand?: string;
  scenario?: DockerSandboxScenario | DockerSandboxScenarioResolver;
  checkpointStore?: SandboxCheckpointStore;
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
  runtimeIdentity: SandboxRuntimeIdentity,
): readonly string[] {
  if (image.trim().length === 0) throw new TypeError("Docker sandbox image must not be empty");
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) {
    throw new TypeError("Docker sandbox container name is invalid");
  }
  const validatedRuntimeIdentity = validateSandboxRuntimeIdentity(runtimeIdentity);
  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    name,
    "--label",
    `${DOCKER_SANDBOX_LABELS.managed}=true`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.supervisorId}=${validatedRuntimeIdentity.supervisorId}`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.bootId}=${validatedRuntimeIdentity.bootId}`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.sandboxId}=${validatedRuntimeIdentity.sandboxId}`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.commandId}=${command.payload.commandId}`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.sessionId}=${command.payload.sessionId}`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.turnId}=${command.payload.turnId}`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.leaseId}=${command.payload.leaseId}`,
    "--label",
    `${DOCKER_SANDBOX_LABELS.fencingToken}=${String(command.payload.fencingToken)}`,
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

export class DockerSandboxTurnRunner {
  readonly #image: string;
  readonly #dockerCommand: string;
  readonly #runtimeIdentity: SandboxRuntimeIdentity;
  readonly #assignmentInventory: DockerSandboxAssignmentInventory;
  readonly #scenario: DockerSandboxScenario | DockerSandboxScenarioResolver;
  readonly #checkpointStore: SandboxCheckpointStore | undefined;
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
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#scenario = options.scenario ?? "java_repair";
    this.#checkpointStore = options.checkpointStore;
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
    this.#assignmentInventory = new DockerSandboxAssignmentInventory({
      sandboxId: this.#runtimeIdentity.sandboxId,
      dockerCommand: this.#dockerCommand,
      timeoutMs: this.#cleanupTimeoutMs,
    });
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#onContainerReady = options.onContainerReady;
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
    signal: AbortSignal,
  ): Promise<PiRpcTurnResult> {
    let loadedCheckpoint: LoadedSandboxCheckpoint | undefined;
    if (this.#checkpointStore !== undefined) {
      try {
        loadedCheckpoint = validateLoadedCheckpoint(await this.#checkpointStore.load(command));
        if (loadedCheckpoint !== undefined) {
          validateWorkspaceSnapshot(loadedCheckpoint.workspace);
        }
      } catch (error: unknown) {
        if (error instanceof PiRpcTurnError) throw error;
        throw new PiRpcTurnError(
          "checkpoint_load_failed",
          "The settled checkpoint could not be loaded",
          true,
        );
      }
    }
    const scenario =
      typeof this.#scenario === "function"
        ? this.#scenario({ command, restoring: loadedCheckpoint !== undefined })
        : this.#scenario;
    const name = containerName(command, this.#idGenerator());
    const identity: DockerSandboxContainerIdentity = {
      ...this.#runtimeIdentity,
      containerName: name,
      commandId: command.payload.commandId,
      sessionId: command.payload.sessionId,
      turnId: command.payload.turnId,
      leaseId: command.payload.leaseId,
      fencingToken: command.payload.fencingToken,
    };
    const child = spawn(
      this.#dockerCommand,
      [...buildDockerSandboxRunArguments(this.#image, name, command, this.#runtimeIdentity)],
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
    let checkpointPublished = false;
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
      if (
        this.#checkpointStore !== undefined &&
        message.payload.event.type === "turn.completed" &&
        !checkpointPublished
      ) {
        throw new PiRpcTurnError(
          "docker_protocol_error",
          "Docker worker completed before its checkpoint was committed",
          false,
        );
      }
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

    const commitCheckpoint = async (
      message: DockerSandboxCheckpointPublishMessage,
    ): Promise<void> => {
      if (this.#checkpointStore === undefined) {
        throw new PiRpcTurnError(
          "docker_protocol_error",
          "Docker worker published a checkpoint while checkpointing was disabled",
          false,
        );
      }
      if (
        checkpointPublished ||
        message.commandId !== command.payload.commandId ||
        message.sessionId !== command.payload.sessionId ||
        message.turnId !== command.payload.turnId ||
        message.leaseId !== command.payload.leaseId ||
        message.fencingToken !== command.payload.fencingToken ||
        message.baseRevision !== (loadedCheckpoint?.revision ?? null)
      ) {
        throw new PiRpcTurnError(
          "docker_protocol_error",
          "Docker checkpoint identity or base revision did not match its activation",
          false,
        );
      }
      const checkpoint = decodeSettledCheckpoint(message.checkpoint);
      validateWorkspaceSnapshot(checkpoint.workspace);
      let saved: { revision: string };
      try {
        saved = await this.#checkpointStore.save(command, message.baseRevision, checkpoint);
      } catch (error: unknown) {
        if (error instanceof PiRpcTurnError) throw error;
        throw new PiRpcTurnError(
          "checkpoint_save_failed",
          "The settled checkpoint could not be committed",
          true,
        );
      }
      if (saved.revision.length < 1 || saved.revision.length > 256) {
        throw new PiRpcTurnError(
          "checkpoint_save_failed",
          "The checkpoint store returned an invalid revision",
          false,
        );
      }
      checkpointPublished = true;
      sendLine(
        child,
        parseDockerSandboxWorkerInput({
          sandboxProtocolVersion: 1,
          type: "sandbox.checkpoint.ack",
          commandId: message.commandId,
          sessionId: message.sessionId,
          turnId: message.turnId,
          leaseId: message.leaseId,
          fencingToken: message.fencingToken,
          revision: saved.revision,
        }),
      );
    };

    const handleMessage = async (message: DockerSandboxWorkerOutput): Promise<void> => {
      if (terminalSettled) {
        throw new PiRpcTurnError(
          "docker_protocol_error",
          "Docker worker emitted output after its terminal result",
          false,
        );
      }
      if (message.type === "sandbox.ready") {
        ready.resolve();
        return;
      }
      if (message.type === "event.publish") {
        await acknowledgeEvent(message);
        return;
      }
      if (message.type === "sandbox.checkpoint.publish") {
        await commitCheckpoint(message);
        return;
      }
      if (
        message.type === "sandbox.result" &&
        this.#checkpointStore !== undefined &&
        !checkpointPublished
      ) {
        throw new PiRpcTurnError(
          "docker_protocol_error",
          "Docker worker returned success without a committed checkpoint",
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
        runtime: { kind: "embedded_fake", scenario },
        workspaceFixture: "java-repair",
        checkpoint:
          this.#checkpointStore === undefined
            ? { mode: "disabled" }
            : {
                mode: "settled",
                baseRevision: loadedCheckpoint?.revision ?? null,
                ...(loadedCheckpoint === undefined
                  ? {}
                  : {
                      restore: encodeSettledCheckpoint({
                        piSession: loadedCheckpoint.piSession,
                        workspace: loadedCheckpoint.workspace,
                      }),
                    }),
              },
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
        await this.#forceRemove(name, command).catch((error: unknown) => {
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
        await this.#forceRemove(name, command).catch((error: unknown) => {
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

  async #forceRemove(name: string, command: ExecuteTurnCommandMessage): Promise<void> {
    const assignment = await this.#assignmentInventory.inspectAssignment(name);
    if (assignment === undefined) return;
    if (
      assignment.supervisorId !== this.#runtimeIdentity.supervisorId ||
      assignment.bootId !== this.#runtimeIdentity.bootId ||
      assignment.sandboxId !== this.#runtimeIdentity.sandboxId ||
      assignment.commandId !== command.payload.commandId ||
      assignment.sessionId !== command.payload.sessionId ||
      assignment.turnId !== command.payload.turnId ||
      assignment.leaseId !== command.payload.leaseId ||
      assignment.fencingToken !== command.payload.fencingToken
    ) {
      throw new PiRpcTurnError(
        "docker_container_identity_mismatch",
        "Docker sandbox cleanup identity did not match",
        false,
      );
    }
    try {
      await this.#assignmentInventory.terminateAndConfirmAbsent(assignment);
    } catch {
      throw new PiRpcTurnError(
        "docker_cleanup_unverified",
        "Docker sandbox removal could not be verified",
        true,
      );
    }
  }
}
