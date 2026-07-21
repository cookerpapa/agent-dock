import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import { activeTraceCarrier, withSpan, type AgentDockMetrics } from "@agent-dock/observability";
import {
  type ExecuteTurnCommandMessage,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxCreateRequest,
  type ToolSandboxCreateResponse,
  type WorkspacePatch,
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
import {
  validateSandboxRuntimeIdentity,
  type SandboxRuntimeIdentity,
} from "./sandbox-assignment-inventory.ts";
import type {
  AgentTurnScenario,
  AgentTurnScenarioResolver,
  AgentWorkspaceSeedResolver,
  TrustedModelRuntimeLease,
  TrustedModelRuntimeLeaseResolver,
} from "./agent-turn-runtime.ts";
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

export type RemoteToolSandboxTurnRunnerOptions = {
  manager: ToolSandboxManagerBoundary;
  runtimeIdentity: SandboxRuntimeIdentity;
  trustedWorkspaceDirectory: string;
  scenario?: AgentTurnScenario | AgentTurnScenarioResolver;
  modelRuntimeLeaseResolver?: TrustedModelRuntimeLeaseResolver;
  workspaceSeedResolver?: AgentWorkspaceSeedResolver;
  checkpointStore?: SandboxCheckpointStore;
  runAttemptPhaseObserver?: RunAttemptPhaseObserver;
  trustedExtensionPath?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  idGenerator?: () => string;
  metrics?: AgentDockMetrics;
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
  readonly #scenario: AgentTurnScenario | AgentTurnScenarioResolver;
  readonly #modelRuntimeLeaseResolver: TrustedModelRuntimeLeaseResolver | undefined;
  readonly #workspaceSeedResolver: AgentWorkspaceSeedResolver | undefined;
  readonly #checkpointStore: SandboxCheckpointStore | undefined;
  readonly #runAttemptPhaseObserver: RunAttemptPhaseObserver | undefined;
  readonly #trustedExtensionPath: string;
  readonly #requestTimeoutMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
  readonly #idGenerator: () => string;
  readonly #metrics: AgentDockMetrics | undefined;

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
    this.#metrics = options.metrics;
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
    signal: AbortSignal,
  ): Promise<PiRpcTurnResult> {
    this.#metrics?.activeRuns.inc();
    const startedAt = performance.now();
    try {
      const result = await withSpan({
        serviceName: "agent-dock-trusted-runner",
        name: "run.execute",
        ...(command.payload.traceContext === undefined
          ? {}
          : { parent: command.payload.traceContext }),
        attributes: {
          "agent_dock.run.id": command.payload.runId,
          "agent_dock.attempt.id": command.payload.attemptId,
          "agent_dock.session.id": command.payload.sessionId,
        },
        run: () => this.#run(command, publishEvent, signal),
      });
      this.#metrics?.runDuration.observe(
        { outcome: "completed" },
        (performance.now() - startedAt) / 1_000,
      );
      return result;
    } catch (error: unknown) {
      this.#metrics?.runDuration.observe(
        { outcome: signal.aborted ? "cancelled" : "failed" },
        (performance.now() - startedAt) / 1_000,
      );
      throw error;
    } finally {
      this.#metrics?.activeRuns.dec();
    }
  }

  async #run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
    signal: AbortSignal,
  ): Promise<PiRpcTurnResult> {
    const downstreamTrace = activeTraceCarrier() ?? command.payload.traceContext;
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
      if (stopPromise === undefined) {
        const startedAt = performance.now();
        stopPromise = this.#manager.stop(activation.activationId, toolAssignment).then(
          () => {
            this.#metrics?.sandboxDuration.observe(
              { operation: "stop", outcome: "completed" },
              (performance.now() - startedAt) / 1_000,
            );
            this.#metrics?.sandboxActive.dec({ provider: "remote" });
          },
          (error: unknown) => {
            this.#metrics?.sandboxDuration.observe(
              { operation: "stop", outcome: "failed" },
              (performance.now() - startedAt) / 1_000,
            );
            throw error;
          },
        );
      }
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
      const createStartedAt = performance.now();
      try {
        activation = await this.#manager.create(createRequest);
        this.#metrics?.sandboxDuration.observe(
          { operation: "create", outcome: "completed" },
          (performance.now() - createStartedAt) / 1_000,
        );
        this.#metrics?.sandboxActive.inc({ provider: "remote" });
      } catch (error: unknown) {
        this.#metrics?.sandboxDuration.observe(
          { operation: "create", outcome: "failed" },
          (performance.now() - createStartedAt) / 1_000,
        );
        throw error;
      }
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
          AGENT_DOCK_TRUSTED_REMAINING_TOOL_CALLS: String(
            command.payload.budgets?.remainingToolCalls ?? 128,
          ),
          AGENT_DOCK_TRUSTED_MAXIMUM_TOOL_OUTPUT_BYTES: String(
            command.payload.budgets?.maximumToolOutputBytes ?? 65_536,
          ),
          ...(downstreamTrace === undefined
            ? {}
            : {
                AGENT_DOCK_TRUSTED_TRACEPARENT: downstreamTrace.traceparent,
                ...(downstreamTrace.tracestate === undefined
                  ? {}
                  : {
                      AGENT_DOCK_TRUSTED_TRACESTATE: downstreamTrace.tracestate,
                    }),
              }),
        },
        collectWorkspacePatch: () => capturedPatch,
        ...(this.#checkpointStore?.saveToolOutput === undefined
          ? {}
          : {
              persistToolOutputArtifact: (output: { toolCallId: string; bytes: Uint8Array }) =>
                this.#checkpointStore!.saveToolOutput!(command, output),
            }),
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
          const checkpointStartedAt = performance.now();
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
              this.#metrics?.checkpointDuration.observe(
                { outcome: "completed" },
                (performance.now() - checkpointStartedAt) / 1_000,
              );
            } catch (error: unknown) {
              this.#metrics?.checkpointDuration.observe(
                { outcome: "failed" },
                (performance.now() - checkpointStartedAt) / 1_000,
              );
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
              turnTimeoutMs: Math.min(
                command.payload.budgets?.maximumRunDurationMs ?? Number.MAX_SAFE_INTEGER,
                usesEmbeddedFake ? 60_000 : modelRuntimeLease!.runtime.turnTimeoutMs,
              ),
            }
          : {
              turnTimeoutMs: Math.min(
                this.#turnTimeoutMs,
                command.payload.budgets?.maximumRunDurationMs ?? Number.MAX_SAFE_INTEGER,
              ),
            }),
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
