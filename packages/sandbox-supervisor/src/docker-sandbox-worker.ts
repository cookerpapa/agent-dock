import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import {
  parseDockerSandboxWorkerInput,
  type DockerSandboxCancelMessage,
  type DockerSandboxCheckpointAckMessage,
  type DockerSandboxCheckpointPublishMessage,
  type DockerSandboxRunMessage,
  type EventAckMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { cp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  PINNED_PI_CODING_AGENT_VERSION,
  PiRpcTurnCancelledError,
  PiRpcTurnError,
  PiRpcTurnRunner,
  type PiRpcCancellationSignal,
} from "./pi-rpc-turn-runner.ts";
import {
  decodeSettledCheckpoint,
  decodeWorkspaceSnapshot,
  encodeSettledCheckpoint,
  type CapturedSandboxCheckpoint,
} from "./sandbox-checkpoint.ts";
import { collectGitWorkspacePatch } from "./git-workspace-patch.ts";
import { captureWorkspaceSnapshot, restoreWorkspaceSnapshot } from "./workspace-snapshot.ts";

const WORKSPACE_DIRECTORY = "/workspace";
const JAVA_REPAIR_FIXTURE = "/opt/agent-dock/sample-java-repair";
const EVENT_ACK_TIMEOUT_MS = 10_000;
const CHECKPOINT_ACK_TIMEOUT_MS = 15_000;

type PendingEventAck = {
  event: EventPublishMessage;
  resolve: (ack: EventAckMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingCheckpointAck = {
  checkpoint: DockerSandboxCheckpointPublishMessage;
  resolve: (ack: DockerSandboxCheckpointAckMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function execute(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 512 * 1_024 },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

function writeMessage(value: unknown): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function prepareWorkspace(
  workspaceSeed: Uint8Array | undefined,
  workspaceSnapshot?: Uint8Array,
): Promise<void> {
  const existing = await readdir(WORKSPACE_DIRECTORY);
  if (existing.length !== 0) {
    throw new PiRpcTurnError(
      "workspace_not_empty",
      "Sandbox workspace was not empty at activation",
      false,
    );
  }
  if (workspaceSeed === undefined) {
    for (const entry of await readdir(JAVA_REPAIR_FIXTURE)) {
      await cp(join(JAVA_REPAIR_FIXTURE, entry), join(WORKSPACE_DIRECTORY, entry), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  } else {
    await restoreWorkspaceSnapshot(WORKSPACE_DIRECTORY, workspaceSeed);
  }
  await execute("git", ["init", "--quiet"], WORKSPACE_DIRECTORY);
  await execute("git", ["config", "user.name", "AgentDock Fixture"], WORKSPACE_DIRECTORY);
  await execute("git", ["config", "user.email", "fixture@agent-dock.invalid"], WORKSPACE_DIRECTORY);
  await execute("git", ["add", "--all"], WORKSPACE_DIRECTORY);
  await execute("git", ["commit", "--quiet", "-m", "fixture baseline"], WORKSPACE_DIRECTORY);
  if (workspaceSnapshot !== undefined) {
    await restoreWorkspaceSnapshot(WORKSPACE_DIRECTORY, workspaceSnapshot);
  }
}

function cancellationSignal(message: DockerSandboxCancelMessage): PiRpcCancellationSignal {
  return {
    kind: "agent-dock.turn-cancellation",
    reason: message.reason,
    gracePeriodMs: message.gracePeriodMs,
  };
}

async function main(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let runMessage: DockerSandboxRunMessage | undefined;
  let runPromise: Promise<void> | undefined;
  let abortController: AbortController | undefined;
  let pendingCancellation: PiRpcCancellationSignal | undefined;
  let pendingEventAck: PendingEventAck | undefined;
  let pendingCheckpointAck: PendingCheckpointAck | undefined;
  let finished = false;

  const finish = async (message: unknown): Promise<void> => {
    if (finished) return;
    finished = true;
    if (pendingEventAck !== undefined) {
      clearTimeout(pendingEventAck.timer);
      pendingEventAck.reject(new Error("Sandbox worker stopped before event ACK"));
      pendingEventAck = undefined;
    }
    if (pendingCheckpointAck !== undefined) {
      clearTimeout(pendingCheckpointAck.timer);
      pendingCheckpointAck.reject(new Error("Sandbox worker stopped before checkpoint ACK"));
      pendingCheckpointAck = undefined;
    }
    await writeMessage(message).catch(() => undefined);
    input.close();
    process.stdin.pause();
  };

  const publishEvent = async (event: EventPublishMessage): Promise<void> => {
    if (pendingEventAck !== undefined) {
      throw new PiRpcTurnError(
        "event_ack_overlap",
        "Sandbox worker attempted concurrent event publication",
        false,
      );
    }
    const acknowledgement = new Promise<EventAckMessage>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pendingEventAck = undefined;
        rejectPromise(
          new PiRpcTurnError("event_ack_timeout", "Control plane event ACK timed out", true),
        );
      }, EVENT_ACK_TIMEOUT_MS);
      timer.unref();
      pendingEventAck = { event, resolve: resolvePromise, reject: rejectPromise, timer };
    });
    await writeMessage(event);
    await acknowledgement;
  };

  const acceptEventAck = (ack: EventAckMessage): void => {
    const pending = pendingEventAck;
    if (pending === undefined) {
      throw new PiRpcTurnError(
        "unexpected_event_ack",
        "Worker received an unexpected event ACK",
        false,
      );
    }
    const event = pending.event;
    if (
      ack.payload.sessionId !== event.payload.event.sessionId ||
      ack.payload.leaseId !== event.payload.leaseId ||
      ack.payload.fencingToken !== event.payload.fencingToken ||
      ack.payload.acknowledgedThroughSeq !== event.payload.event.seq
    ) {
      throw new PiRpcTurnError(
        "invalid_event_ack",
        "Worker received a mismatched event ACK",
        false,
      );
    }
    clearTimeout(pending.timer);
    pendingEventAck = undefined;
    pending.resolve(ack);
  };

  const publishCheckpoint = async (
    message: DockerSandboxRunMessage,
    checkpoint: CapturedSandboxCheckpoint,
  ): Promise<void> => {
    if (pendingCheckpointAck !== undefined || pendingEventAck !== undefined) {
      throw new PiRpcTurnError(
        "checkpoint_ack_overlap",
        "Sandbox worker attempted overlapping checkpoint publication",
        false,
      );
    }
    if (message.checkpoint.mode !== "settled") {
      throw new PiRpcTurnError(
        "checkpoint_protocol_error",
        "Sandbox worker attempted checkpoint publication while disabled",
        false,
      );
    }
    const publication: DockerSandboxCheckpointPublishMessage = {
      sandboxProtocolVersion: 1,
      type: "sandbox.checkpoint.publish",
      commandId: message.command.payload.commandId,
      sessionId: message.command.payload.sessionId,
      turnId: message.command.payload.turnId,
      leaseId: message.command.payload.leaseId,
      fencingToken: message.command.payload.fencingToken,
      baseRevision: message.checkpoint.baseRevision,
      checkpoint: encodeSettledCheckpoint(checkpoint),
    };
    const acknowledgement = new Promise<DockerSandboxCheckpointAckMessage>(
      (resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pendingCheckpointAck = undefined;
          rejectPromise(
            new PiRpcTurnError(
              "checkpoint_ack_timeout",
              "Trusted host checkpoint ACK timed out",
              true,
            ),
          );
        }, CHECKPOINT_ACK_TIMEOUT_MS);
        timer.unref();
        pendingCheckpointAck = {
          checkpoint: publication,
          resolve: resolvePromise,
          reject: rejectPromise,
          timer,
        };
      },
    );
    await writeMessage(publication);
    await acknowledgement;
  };

  const acceptCheckpointAck = (ack: DockerSandboxCheckpointAckMessage): void => {
    const pending = pendingCheckpointAck;
    if (pending === undefined) {
      throw new PiRpcTurnError(
        "unexpected_checkpoint_ack",
        "Worker received an unexpected checkpoint ACK",
        false,
      );
    }
    const checkpoint = pending.checkpoint;
    if (
      ack.commandId !== checkpoint.commandId ||
      ack.sessionId !== checkpoint.sessionId ||
      ack.turnId !== checkpoint.turnId ||
      ack.leaseId !== checkpoint.leaseId ||
      ack.fencingToken !== checkpoint.fencingToken
    ) {
      throw new PiRpcTurnError(
        "invalid_checkpoint_ack",
        "Worker received a mismatched checkpoint ACK",
        false,
      );
    }
    clearTimeout(pending.timer);
    pendingCheckpointAck = undefined;
    pending.resolve(ack);
  };

  const run = async (message: DockerSandboxRunMessage): Promise<void> => {
    const fakeModel =
      message.runtime.kind === "embedded_fake"
        ? new FakeModelServer({ defaultScenario: message.runtime.scenario })
        : undefined;
    abortController = new AbortController();
    if (pendingCancellation !== undefined) abortController.abort(pendingCancellation);
    try {
      if (
        message.checkpoint.mode === "settled" &&
        (message.checkpoint.baseRevision === null) !== (message.checkpoint.restore === undefined)
      ) {
        throw new PiRpcTurnError(
          "checkpoint_protocol_error",
          "Checkpoint revision and restore payload do not form a valid pair",
          false,
        );
      }
      const restored =
        message.checkpoint.mode === "settled" && message.checkpoint.restore !== undefined
          ? decodeSettledCheckpoint(message.checkpoint.restore)
          : undefined;
      const workspaceSeed =
        message.workspaceSeed.kind === "snapshot"
          ? decodeWorkspaceSnapshot(message.workspaceSeed.snapshot)
          : undefined;
      await prepareWorkspace(workspaceSeed, restored?.workspace);
      await fakeModel?.start();
      if (
        message.runtime.kind === "openai_compatible_gateway" &&
        (message.runtime.provider !== message.command.payload.model.provider ||
          message.runtime.modelId !== message.command.payload.model.modelId)
      ) {
        throw new PiRpcTurnError(
          "model_binding_mismatch",
          "Gateway runtime does not match the accepted turn",
          false,
        );
      }
      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => WORKSPACE_DIRECTORY,
        resolveModelRuntime: (model) =>
          message.runtime.kind === "embedded_fake"
            ? {
                provider: model.provider,
                modelId: model.modelId,
                baseUrl: fakeModel!.baseUrl,
                api: "openai-completions",
                apiKey: FAKE_MODEL_API_KEY,
              }
            : {
                provider: message.runtime.provider,
                modelId: message.runtime.modelId,
                baseUrl: message.runtime.baseUrl,
                api: "openai-completions",
                apiKey: message.runtime.capability,
                reasoning: message.runtime.reasoning,
                contextWindow: message.runtime.contextWindow,
                maxTokens: message.runtime.maxTokens,
              },
        enabledTools: ["bash", "edit"],
        collectWorkspacePatch: () => collectGitWorkspacePatch(WORKSPACE_DIRECTORY),
        ...(restored === undefined ? {} : { restorePiSession: restored.piSession }),
        ...(message.checkpoint.mode === "settled"
          ? {
              onSettled: async ({ piSession }: { piSession: Uint8Array }) => {
                await publishCheckpoint(message, {
                  piSession,
                  workspace: await captureWorkspaceSnapshot(WORKSPACE_DIRECTORY),
                });
              },
            }
          : {}),
        requestTimeoutMs:
          message.runtime.kind === "embedded_fake" ? 10_000 : message.runtime.requestTimeoutMs,
        turnTimeoutMs:
          message.runtime.kind === "embedded_fake" ? 60_000 : message.runtime.turnTimeoutMs,
      });
      const result = await runner.run(message.command, publishEvent, abortController.signal);
      await finish({
        sandboxProtocolVersion: 1,
        type: "sandbox.result",
        stopReason: result.stopReason,
      });
    } catch (error: unknown) {
      if (error instanceof PiRpcTurnCancelledError) {
        await finish({
          sandboxProtocolVersion: 1,
          type: "sandbox.cancelled",
          reason: error.reason,
          forced: error.forced,
        });
      } else if (error instanceof PiRpcTurnError) {
        await finish({
          sandboxProtocolVersion: 1,
          type: "sandbox.failed",
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        });
      } else {
        await finish({
          sandboxProtocolVersion: 1,
          type: "sandbox.failed",
          code: "sandbox_worker_error",
          message: "Sandbox worker failed",
          retryable: true,
        });
      }
    } finally {
      await fakeModel?.stop().catch(() => undefined);
    }
  };

  input.on("line", (line) => {
    void (async () => {
      if (finished || line.trim().length === 0) return;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new PiRpcTurnError("invalid_worker_input", "Worker input was not valid JSONL", false);
      }
      const message = parseDockerSandboxWorkerInput(value);
      if (message.type === "event.ack") {
        acceptEventAck(message);
        return;
      }
      if (message.type === "sandbox.checkpoint.ack") {
        acceptCheckpointAck(message);
        return;
      }
      if (message.type === "sandbox.cancel") {
        const signal = cancellationSignal(message);
        pendingCancellation = signal;
        abortController?.abort(signal);
        return;
      }
      if (runMessage !== undefined || runPromise !== undefined) {
        throw new PiRpcTurnError("duplicate_run", "Sandbox worker received a duplicate run", false);
      }
      runMessage = message;
      runPromise = run(message);
      await runPromise;
    })().catch(async (error: unknown) => {
      await finish({
        sandboxProtocolVersion: 1,
        type: "sandbox.failed",
        code: error instanceof PiRpcTurnError ? error.code : "invalid_worker_input",
        message: error instanceof PiRpcTurnError ? error.message : "Sandbox worker input failed",
        retryable: error instanceof PiRpcTurnError ? error.retryable : false,
      });
    });
  });

  input.once("close", () => {
    if (finished) return;
    if (runPromise === undefined) {
      void finish({
        sandboxProtocolVersion: 1,
        type: "sandbox.failed",
        code: "worker_input_closed",
        message: "Sandbox worker input closed before execution",
        retryable: true,
      });
      return;
    }
    const signal: PiRpcCancellationSignal = {
      kind: "agent-dock.turn-cancellation",
      reason: "shutdown",
      gracePeriodMs: 0,
    };
    pendingCancellation = signal;
    abortController?.abort(signal);
    const forcedExit = setTimeout(() => process.exit(1), 5_000);
    void runPromise.finally(() => clearTimeout(forcedExit));
  });

  process.once("SIGTERM", () => {
    const signal: PiRpcCancellationSignal = {
      kind: "agent-dock.turn-cancellation",
      reason: "shutdown",
      gracePeriodMs: 0,
    };
    pendingCancellation = signal;
    abortController?.abort(signal);
  });

  await writeMessage({
    sandboxProtocolVersion: 1,
    type: "sandbox.ready",
    piVersion: PINNED_PI_CODING_AGENT_VERSION,
  });
}

await main();
