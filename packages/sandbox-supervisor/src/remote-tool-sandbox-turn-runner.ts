import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import {
  type ExecuteTurnCommandMessage,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxCreateRequest,
  type ToolSandboxCreateResponse,
  type WorkspacePatch,
  type DockerSandboxModelRuntime,
} from "@agent-dock/protocol";
import {
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
} from "@agent-dock/workspace-runtime";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SupervisorTurnRunner } from "./local-sandbox-supervisor.ts";
import {
  PiRpcTurnError,
  PiRpcTurnRunner,
  type PiRpcEventPublisher,
  type PiRpcTurnResult,
} from "./pi-rpc-turn-runner.ts";
import {
  validateLoadedCheckpoint,
  type LoadedSandboxCheckpoint,
  type SandboxCheckpointStore,
} from "./sandbox-checkpoint.ts";
import type {
  DockerSandboxScenario,
  DockerSandboxScenarioResolver,
  DockerSandboxWorkspaceSeedResolver,
} from "./docker-sandbox-turn-runner.ts";
import {
  validateSandboxRuntimeIdentity,
  type SandboxRuntimeIdentity,
} from "./docker-sandbox-assignment-inventory.ts";
import type { RunAttemptPhaseObserver } from "./run-attempt-phase.ts";

export interface ToolSandboxManagerBoundary {
  create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse>;
  capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<ToolSandboxCaptureResponse>;
  stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void>;
  readonly operationUrl: string;
}

export type TrustedModelRuntimeLease = Readonly<{
  runtime: Extract<DockerSandboxModelRuntime, { kind: "openai_compatible_gateway" }>;
  release(): Promise<void> | void;
}>;

export type TrustedModelRuntimeLeaseResolver = (
  command: ExecuteTurnCommandMessage,
) => Promise<TrustedModelRuntimeLease> | TrustedModelRuntimeLease;

export type RemoteToolSandboxTurnRunnerOptions = {
  manager: ToolSandboxManagerBoundary;
  runtimeIdentity: SandboxRuntimeIdentity;
  trustedWorkspaceDirectory: string;
  scenario?: DockerSandboxScenario | DockerSandboxScenarioResolver;
  modelRuntimeLeaseResolver?: TrustedModelRuntimeLeaseResolver;
  workspaceSeedResolver?: DockerSandboxWorkspaceSeedResolver;
  checkpointStore?: SandboxCheckpointStore;
  runAttemptPhaseObserver?: RunAttemptPhaseObserver;
  trustedExtensionPath?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  idGenerator?: () => string;
};

function assignment(
  command: ExecuteTurnCommandMessage,
  runtimeIdentity: SandboxRuntimeIdentity,
): ToolSandboxAssignment {
  return {
    tenantId: command.payload.tenantId,
    ...runtimeIdentity,
    commandId: command.payload.commandId,
    sessionId: command.payload.sessionId,
    turnId: command.payload.turnId,
    attemptId: command.payload.attemptId,
    leaseId: command.payload.leaseId,
    fencingToken: command.payload.fencingToken,
  };
}

function safePiError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): PiRpcTurnError {
  if (error instanceof PiRpcTurnError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return new PiRpcTurnError(error.code, fallbackMessage, error.retryable);
  }
  return new PiRpcTurnError(fallbackCode, fallbackMessage, true);
}

async function releaseModelRuntimeLease(
  lease: TrustedModelRuntimeLease | undefined,
): Promise<void> {
  if (lease !== undefined) await lease.release();
}

function defaultTrustedExtensionPath(): string {
  return resolve(import.meta.dirname, "trusted-remote-tools-extension.ts");
}

export class RemoteToolSandboxTurnRunner implements SupervisorTurnRunner {
  readonly #manager: ToolSandboxManagerBoundary;
  readonly #runtimeIdentity: SandboxRuntimeIdentity;
  readonly #trustedWorkspaceDirectory: string;
  readonly #scenario: DockerSandboxScenario | DockerSandboxScenarioResolver;
  readonly #modelRuntimeLeaseResolver: TrustedModelRuntimeLeaseResolver | undefined;
  readonly #workspaceSeedResolver: DockerSandboxWorkspaceSeedResolver | undefined;
  readonly #checkpointStore: SandboxCheckpointStore | undefined;
  readonly #runAttemptPhaseObserver: RunAttemptPhaseObserver | undefined;
  readonly #trustedExtensionPath: string;
  readonly #requestTimeoutMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
  readonly #idGenerator: () => string;

  constructor(options: RemoteToolSandboxTurnRunnerOptions) {
    this.#manager = options.manager;
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#trustedWorkspaceDirectory = resolve(options.trustedWorkspaceDirectory);
    this.#scenario = options.scenario ?? "java_repair";
    this.#modelRuntimeLeaseResolver = options.modelRuntimeLeaseResolver;
    this.#workspaceSeedResolver = options.workspaceSeedResolver;
    this.#checkpointStore = options.checkpointStore;
    this.#runAttemptPhaseObserver = options.runAttemptPhaseObserver;
    this.#trustedExtensionPath = resolve(
      options.trustedExtensionPath ?? defaultTrustedExtensionPath(),
    );
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#turnTimeoutMs = options.turnTimeoutMs;
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
    signal: AbortSignal,
  ): Promise<PiRpcTurnResult> {
    const trustedWorkspace = await stat(this.#trustedWorkspaceDirectory).catch(() => undefined);
    if (!trustedWorkspace?.isDirectory()) {
      throw new PiRpcTurnError(
        "trusted_runner_workspace_unavailable",
        "Trusted Agent Runner virtual workspace is unavailable",
        true,
      );
    }

    let loadedCheckpoint: LoadedSandboxCheckpoint | undefined;
    if (this.#checkpointStore !== undefined) {
      try {
        loadedCheckpoint = validateLoadedCheckpoint(await this.#checkpointStore.load(command));
      } catch (error: unknown) {
        throw safePiError(
          error,
          "checkpoint_load_failed",
          "The settled checkpoint could not be loaded",
        );
      }
    }
    if (loadedCheckpoint !== undefined && this.#runAttemptPhaseObserver !== undefined) {
      try {
        await this.#runAttemptPhaseObserver.transition(command, "restoring");
      } catch (error: unknown) {
        throw safePiError(
          error,
          "run_phase_persist_failed",
          "Run restore phase could not be persisted",
        );
      }
    }

    let workspaceSeed: Uint8Array | undefined;
    if (this.#workspaceSeedResolver !== undefined) {
      try {
        workspaceSeed = await this.#workspaceSeedResolver(command, signal);
      } catch (error: unknown) {
        throw safePiError(
          error,
          "workspace_seed_unavailable",
          "Workspace source could not be provisioned",
        );
      }
    }

    const usesEmbeddedFake =
      command.payload.model.provider === "agent-dock-fake" &&
      command.payload.model.modelId === "agent-dock-fake";
    let modelRuntimeLease: TrustedModelRuntimeLease | undefined;
    if (!usesEmbeddedFake) {
      if (this.#modelRuntimeLeaseResolver === undefined) {
        throw new PiRpcTurnError(
          "credential_unavailable",
          "A real model runtime is not configured for this Agent Runner",
          true,
        );
      }
      modelRuntimeLease = await this.#modelRuntimeLeaseResolver(command);
      if (
        modelRuntimeLease.runtime.provider !== command.payload.model.provider ||
        modelRuntimeLease.runtime.modelId !== command.payload.model.modelId
      ) {
        await releaseModelRuntimeLease(modelRuntimeLease).catch(() => undefined);
        throw new PiRpcTurnError(
          "model_binding_mismatch",
          "Resolved model runtime does not match the accepted turn",
          false,
        );
      }
    }

    const scenario =
      typeof this.#scenario === "function"
        ? this.#scenario({ command, restoring: loadedCheckpoint !== undefined })
        : this.#scenario;
    const toolAssignment = assignment(command, this.#runtimeIdentity);
    let activation: ToolSandboxCreateResponse | undefined;
    let fakeModel: FakeModelServer | undefined;
    let capturedPatch: WorkspacePatch | undefined;
    let stopPromise: Promise<void> | undefined;
    const stopSandbox = (): Promise<void> => {
      if (activation === undefined) return Promise.resolve();
      stopPromise ??= this.#manager.stop(activation.activationId, toolAssignment);
      return stopPromise;
    };
    const abortSandbox = (): void => {
      void stopSandbox().catch(() => undefined);
    };

    try {
      const createRequest: ToolSandboxCreateRequest = {
        managerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: this.#idGenerator(),
        assignment: toolAssignment,
        workspaceSeed:
          workspaceSeed === undefined
            ? { kind: "sample_java" }
            : { kind: "snapshot", snapshot: encodeWorkspaceSnapshotBlob(workspaceSeed) },
        ...(loadedCheckpoint === undefined
          ? {}
          : { workspaceRestore: encodeWorkspaceSnapshotBlob(loadedCheckpoint.workspace) }),
      };
      activation = await this.#manager.create(createRequest);
      signal.addEventListener("abort", abortSandbox, { once: true });
      if (signal.aborted) abortSandbox();

      if (usesEmbeddedFake) {
        fakeModel = new FakeModelServer({ defaultScenario: scenario });
        await fakeModel.start();
      }
      if (this.#runAttemptPhaseObserver !== undefined) {
        try {
          await this.#runAttemptPhaseObserver.transition(command, "running");
        } catch (error: unknown) {
          throw safePiError(
            error,
            "run_phase_persist_failed",
            "Run execution phase could not be persisted",
          );
        }
      }

      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => this.#trustedWorkspaceDirectory,
        resolveModelRuntime: (model) =>
          usesEmbeddedFake
            ? {
                provider: model.provider,
                modelId: model.modelId,
                baseUrl: fakeModel!.baseUrl,
                api: "openai-completions",
                apiKey: FAKE_MODEL_API_KEY,
              }
            : {
                provider: modelRuntimeLease!.runtime.provider,
                modelId: modelRuntimeLease!.runtime.modelId,
                baseUrl: modelRuntimeLease!.runtime.baseUrl,
                api: "openai-completions",
                apiKey: modelRuntimeLease!.runtime.capability,
                ...(modelRuntimeLease!.runtime.reasoning === undefined
                  ? {}
                  : { reasoning: modelRuntimeLease!.runtime.reasoning }),
                ...(modelRuntimeLease!.runtime.contextWindow === undefined
                  ? {}
                  : { contextWindow: modelRuntimeLease!.runtime.contextWindow }),
                ...(modelRuntimeLease!.runtime.maxTokens === undefined
                  ? {}
                  : { maxTokens: modelRuntimeLease!.runtime.maxTokens }),
              },
        disableBuiltinTools: true,
        trustedExtensionPaths: [this.#trustedExtensionPath],
        trustedEnvironment: {
          AGENT_DOCK_TRUSTED_TOOL_OPERATION_URL: this.#manager.operationUrl,
          AGENT_DOCK_TRUSTED_TOOL_ACTIVATION_ID: activation.activationId,
          AGENT_DOCK_TRUSTED_TOOL_CAPABILITY: activation.capability,
        },
        collectWorkspacePatch: () => capturedPatch,
        ...(loadedCheckpoint === undefined ? {} : { restorePiSession: loadedCheckpoint.piSession }),
        onSettled: async ({ piSession }) => {
          if (activation === undefined) {
            throw new PiRpcTurnError(
              "tool_sandbox_unavailable",
              "Tool Sandbox was unavailable at settlement",
              true,
            );
          }
          if (this.#runAttemptPhaseObserver !== undefined) {
            try {
              await this.#runAttemptPhaseObserver.transition(command, "checkpointing");
            } catch (error: unknown) {
              throw safePiError(
                error,
                "run_phase_persist_failed",
                "Run checkpoint phase could not be persisted",
              );
            }
          }
          const captured = await this.#manager.capture(activation.activationId, toolAssignment);
          const workspace = decodeWorkspaceSnapshotBlob(captured.workspace);
          capturedPatch = captured.workspacePatch;
          if (this.#checkpointStore !== undefined) {
            try {
              const saved = await this.#checkpointStore.save(
                command,
                loadedCheckpoint?.revision ?? null,
                {
                  piSession,
                  workspace,
                  ...(capturedPatch === undefined ? {} : { workspacePatch: capturedPatch }),
                },
              );
              await this.#runAttemptPhaseObserver?.checkpointCommitted(command, saved.revision);
            } catch (error: unknown) {
              throw safePiError(
                error,
                "checkpoint_save_failed",
                "The settled checkpoint could not be committed",
              );
            }
          }
        },
        ...(this.#requestTimeoutMs === undefined
          ? {
              requestTimeoutMs: usesEmbeddedFake
                ? 10_000
                : modelRuntimeLease!.runtime.requestTimeoutMs,
            }
          : { requestTimeoutMs: this.#requestTimeoutMs }),
        ...(this.#turnTimeoutMs === undefined
          ? {
              turnTimeoutMs: usesEmbeddedFake ? 60_000 : modelRuntimeLease!.runtime.turnTimeoutMs,
            }
          : { turnTimeoutMs: this.#turnTimeoutMs }),
      });
      return await runner.run(command, publishEvent, signal);
    } finally {
      signal.removeEventListener("abort", abortSandbox);
      await fakeModel?.stop().catch(() => undefined);
      let cleanupError: unknown;
      await stopSandbox().catch((error: unknown) => {
        cleanupError = error;
      });
      await releaseModelRuntimeLease(modelRuntimeLease).catch((error: unknown) => {
        cleanupError ??= error;
      });
      if (cleanupError !== undefined) {
        throw safePiError(
          cleanupError,
          "trusted_runner_cleanup_failed",
          "Trusted Agent Runner cleanup could not be confirmed",
        );
      }
    }
  }
}
