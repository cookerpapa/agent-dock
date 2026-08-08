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
  parseKopiaWorkspaceCheckpoint,
  parseWorkspaceSnapshot,
} from "@agent-dock/workspace-runtime";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SupervisorTurnRunner } from "./local-sandbox-supervisor.ts";
import { PiTurnError, type PiEventPublisher, type PiTurnResult } from "./pi-turn-runtime.ts";
import {
  PiSdkTurnRunner,
  type PiSdkIsolationFailure,
  type PiSdkTurnRunnerOptions,
} from "./pi-sdk-turn-runner.ts";
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
import { createTrustedRemoteToolsExtension } from "./trusted-remote-tools-extension.ts";
import {
  createCloudAttemptContext,
  createCloudStepContext,
  createCloudTurnContext,
} from "./cloud-context.ts";

const MAX_PROJECT_INSTRUCTIONS_BYTES = 16 * 1_024;

export function projectInstructionsFromSnapshot(
  snapshot: Uint8Array | undefined,
): string | undefined {
  if (snapshot === undefined) return undefined;
  if (parseKopiaWorkspaceCheckpoint(snapshot) !== undefined) {
    // Provider-native checkpoints intentionally contain only a bounded file
    // index and recovery authority. Their file bytes are available only after
    // the Tool Sandbox has restored the snapshot, so they cannot be inspected
    // in the trusted Runner before lazy activation.
    return undefined;
  }
  const file = parseWorkspaceSnapshot(snapshot).find((entry) => entry.path === "AGENTS.md");
  if (file === undefined) return undefined;
  const bounded = file.content.subarray(0, MAX_PROJECT_INSTRUCTIONS_BYTES);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bounded);
  } catch {
    return undefined;
  }
  if (content.includes("\0") || content.trim().length === 0) return undefined;
  return `${content}${file.content.byteLength > bounded.byteLength ? "\n[AGENTS.md truncated by AgentDock]" : ""}`;
}

export interface ToolSandboxManagerBoundary {
  create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse>;
  capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<ToolSandboxCaptureResponse>;
  release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition: { kind: "keep_warm"; workspaceRevision: string } | { kind: "destroy" },
  ): Promise<{ retained: boolean }>;
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
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  idGenerator?: () => string;
  metrics?: AgentDockMetrics;
  onPiSdkIsolationFailure?: (error: PiSdkIsolationFailure) => Promise<void> | void;
};

function assignment(
  command: ExecuteTurnCommandMessage,
  runtimeIdentity: SandboxRuntimeIdentity,
): ToolSandboxAssignment {
  return {
    tenantId: command.payload.tenantId,
    projectId: command.payload.projectId,
    workspaceId: command.payload.workspaceId,
    ...runtimeIdentity,
    commandId: command.payload.commandId,
    sessionId: command.payload.sessionId,
    turnId: command.payload.turnId,
    attemptId: command.payload.attemptId,
    leaseId: command.payload.leaseId,
    fencingToken: command.payload.fencingToken,
  };
}

function safePiError(error: unknown, fallbackCode: string, fallbackMessage: string): PiTurnError {
  if (error instanceof PiTurnError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return new PiTurnError(error.code, fallbackMessage, error.retryable);
  }
  return new PiTurnError(fallbackCode, fallbackMessage, true);
}

async function releaseModelRuntimeLease(
  lease: TrustedModelRuntimeLease | undefined,
): Promise<void> {
  if (lease !== undefined) await lease.release();
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
  readonly #requestTimeoutMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
  readonly #idGenerator: () => string;
  readonly #metrics: AgentDockMetrics | undefined;
  readonly #onPiSdkIsolationFailure:
    ((error: PiSdkIsolationFailure) => Promise<void> | void) | undefined;
  readonly #activePiRunners = new Map<
    string,
    {
      ready: Promise<PiSdkTurnRunner>;
      resolve: (runner: PiSdkTurnRunner) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(options: RemoteToolSandboxTurnRunnerOptions) {
    this.#manager = options.manager;
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#trustedWorkspaceDirectory = resolve(options.trustedWorkspaceDirectory);
    this.#scenario = options.scenario ?? "java_repair";
    this.#modelRuntimeLeaseResolver = options.modelRuntimeLeaseResolver;
    this.#workspaceSeedResolver = options.workspaceSeedResolver;
    this.#checkpointStore = options.checkpointStore;
    this.#runAttemptPhaseObserver = options.runAttemptPhaseObserver;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#turnTimeoutMs = options.turnTimeoutMs;
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#metrics = options.metrics;
    this.#onPiSdkIsolationFailure = options.onPiSdkIsolationFailure;
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal: AbortSignal,
  ): Promise<PiTurnResult> {
    if (this.#activePiRunners.has(command.payload.commandId)) {
      throw new PiTurnError(
        "pi_runtime_overlap",
        "Pi Runtime is already active for this command",
        false,
      );
    }
    let resolveRunner!: (runner: PiSdkTurnRunner) => void;
    let rejectRunner!: (error: Error) => void;
    const ready = new Promise<PiSdkTurnRunner>((resolvePromise, rejectPromise) => {
      resolveRunner = resolvePromise;
      rejectRunner = rejectPromise;
    });
    void ready.catch(() => undefined);
    const slot = { ready, resolve: resolveRunner, reject: rejectRunner };
    this.#activePiRunners.set(command.payload.commandId, slot);
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
        run: () => this.#run(command, publishEvent, signal, slot.resolve),
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
      if (this.#activePiRunners.get(command.payload.commandId) === slot) {
        this.#activePiRunners.delete(command.payload.commandId);
      }
      slot.reject(
        new PiTurnError(
          "steer_target_unavailable",
          "Pi Run ended before the steer could be delivered",
          false,
        ),
      );
      this.#metrics?.activeRuns.dec();
    }
  }

  async steer(targetCommandId: string, text: string): Promise<void> {
    const slot = this.#activePiRunners.get(targetCommandId);
    if (slot === undefined) {
      throw new PiTurnError(
        "steer_target_unavailable",
        "Pi Run is not active on this Worker",
        false,
      );
    }
    const runner = await slot.ready;
    if (this.#activePiRunners.get(targetCommandId) !== slot) {
      throw new PiTurnError(
        "steer_target_unavailable",
        "Pi Run ended before the steer could be delivered",
        false,
      );
    }
    await runner.steer(text);
  }

  async #run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal: AbortSignal,
    onPiRunnerReady: (runner: PiSdkTurnRunner) => void,
  ): Promise<PiTurnResult> {
    const downstreamTrace = activeTraceCarrier() ?? command.payload.traceContext;
    const trustedWorkspace = await stat(this.#trustedWorkspaceDirectory).catch(() => undefined);
    if (!trustedWorkspace?.isDirectory()) {
      throw new PiTurnError(
        "trusted_runner_workspace_unavailable",
        "Trusted Agent Runner virtual workspace is unavailable",
        true,
      );
    }

    let loadedCheckpoint: LoadedSandboxCheckpoint | undefined;
    if (this.#checkpointStore !== undefined) {
      const restoreStartedAt = performance.now();
      try {
        loadedCheckpoint = validateLoadedCheckpoint(await this.#checkpointStore.load(command));
        this.#metrics?.checkpointRestoreDuration.observe(
          { outcome: loadedCheckpoint === undefined ? "empty" : "completed" },
          (performance.now() - restoreStartedAt) / 1_000,
        );
      } catch (error: unknown) {
        this.#metrics?.checkpointRestoreDuration.observe(
          { outcome: "failed" },
          (performance.now() - restoreStartedAt) / 1_000,
        );
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
    const projectInstructions = projectInstructionsFromSnapshot(
      loadedCheckpoint?.workspace ?? workspaceSeed,
    );
    const cloudTurn = createCloudTurnContext(command, loadedCheckpoint?.workspaceRevision);

    const usesEmbeddedFake =
      command.payload.model.provider === "agent-dock-fake" &&
      command.payload.model.modelId === "agent-dock-fake";
    let modelRuntimeLease: TrustedModelRuntimeLease | undefined;
    if (!usesEmbeddedFake) {
      if (this.#modelRuntimeLeaseResolver === undefined) {
        throw new PiTurnError(
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
        throw new PiTurnError(
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
    const cloudAttempt = createCloudAttemptContext({
      command,
      runtimeIdentity: this.#runtimeIdentity,
      turnContextSha256: cloudTurn.sha256,
    });
    let activation: ToolSandboxCreateResponse | undefined;
    let fakeModel: FakeModelServer | undefined;
    let capturedPatch: WorkspacePatch | undefined;
    let retainedWorkspaceRevision: string | undefined;
    let completedSuccessfully = false;
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
        turnContextSha256: cloudTurn.sha256,
        attemptContextSha256: cloudAttempt.sha256,
        environment: command.payload.environment,
        workspaceSeed:
          workspaceSeed === undefined
            ? { kind: "sample_java" }
            : { kind: "snapshot", snapshot: encodeWorkspaceSnapshotBlob(workspaceSeed) },
        ...(loadedCheckpoint === undefined
          ? {}
          : {
              ...(loadedCheckpoint.workspace === undefined
                ? {}
                : { workspaceRestore: encodeWorkspaceSnapshotBlob(loadedCheckpoint.workspace) }),
              ...(loadedCheckpoint.workspaceRevision === undefined
                ? {}
                : { workspaceRevision: loadedCheckpoint.workspaceRevision }),
            }),
      };
      const createStartedAt = performance.now();
      try {
        activation = await this.#manager.create(createRequest);
        this.#metrics?.sandboxDuration.observe(
          { operation: "reserve", outcome: "completed" },
          (performance.now() - createStartedAt) / 1_000,
        );
      } catch (error: unknown) {
        this.#metrics?.sandboxDuration.observe(
          { operation: "reserve", outcome: "failed" },
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

      const resolveModelRuntime: PiSdkTurnRunnerOptions["resolveModelRuntime"] = (model) =>
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
            };
      const onSettled: NonNullable<PiSdkTurnRunnerOptions["onSettled"]> = async ({ piSession }) => {
        if (activation === undefined) {
          throw new PiTurnError(
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
        const captured = await this.#manager
          .capture(activation.activationId, toolAssignment)
          .catch((error: unknown) => {
            this.#metrics?.checkpointDuration.observe(
              { outcome: "failed" },
              (performance.now() - checkpointStartedAt) / 1_000,
            );
            throw safePiError(
              error,
              "workspace_checkpoint_capture_failed",
              "The Tool Workspace checkpoint could not be captured",
            );
          });
        if (this.#checkpointStore !== undefined) {
          try {
            const saved =
              captured.type === "tool_sandbox.unused"
                ? await this.#checkpointStore.saveConversation(
                    command,
                    loadedCheckpoint?.revision ?? null,
                    piSession,
                  )
                : await this.#checkpointStore.save(command, loadedCheckpoint?.revision ?? null, {
                    piSession,
                    workspace: decodeWorkspaceSnapshotBlob(captured.workspace),
                    environment: captured.environment,
                    ...(captured.workspacePatch === undefined
                      ? {}
                      : { workspacePatch: captured.workspacePatch }),
                  });
            capturedPatch =
              captured.type === "tool_sandbox.captured" ? captured.workspacePatch : undefined;
            retainedWorkspaceRevision = saved.workspaceRevision;
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
        } else if (captured.type === "tool_sandbox.captured") {
          capturedPatch = captured.workspacePatch;
          retainedWorkspaceRevision = captured.workspace.sha256;
        } else {
          retainedWorkspaceRevision = loadedCheckpoint?.workspaceRevision;
        }
      };
      const onInterrupted: NonNullable<PiSdkTurnRunnerOptions["onInterrupted"]> = async ({
        piSession,
      }) => {
        if (this.#checkpointStore === undefined) return;
        try {
          await this.#checkpointStore.saveInterruptedConversation(
            command,
            loadedCheckpoint?.revision ?? null,
            piSession,
          );
        } catch (error: unknown) {
          throw safePiError(
            error,
            "checkpoint_save_failed",
            "The interrupted conversation checkpoint could not be committed",
          );
        }
      };
      const activeSandbox = activation;
      const commonRunnerOptions = {
        resolveWorkspaceDirectory: () => this.#trustedWorkspaceDirectory,
        resolveModelRuntime,
        collectWorkspacePatch: () => capturedPatch,
        ...(this.#checkpointStore?.saveToolOutput === undefined
          ? {}
          : {
              persistToolOutputArtifact: (output: { toolCallId: string; bytes: Uint8Array }) =>
                this.#checkpointStore!.saveToolOutput!(command, output),
            }),
        ...(loadedCheckpoint?.piSession === undefined
          ? {}
          : { restorePiSession: loadedCheckpoint.piSession }),
        ...(loadedCheckpoint?.recoverySuffix === undefined
          ? {}
          : { recoverySuffix: loadedCheckpoint.recoverySuffix }),
        sandboxContinuity: {
          activationId: activeSandbox.activationId,
          continuity: activeSandbox.continuity,
          environmentSha256: cloudTurn.environmentSha256,
          committedWorkspaceRevision: loadedCheckpoint?.workspaceRevision ?? null,
          toolPolicySha256: cloudTurn.toolPolicySha256,
        },
        onSettled,
        onInterrupted,
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
      };
      const runner = new PiSdkTurnRunner({
        ...commonRunnerOptions,
        createInlineExtensions: ({ toolOutputDirectory, stepWorldState, captureSamplingStep }) => {
          if (stepWorldState === undefined) {
            throw new PiTurnError(
              "step_world_state_unavailable",
              "Pi Step world state was not initialized",
              false,
            );
          }
          let stepSequence = 0;
          return [
            createTrustedRemoteToolsExtension({
              operationUrl: this.#manager.operationUrl,
              activationId: activeSandbox.activationId,
              capability: activeSandbox.capability,
              turnContextSha256: cloudTurn.sha256,
              attemptContextSha256: cloudAttempt.sha256,
              captureStepContext: (activeTools) =>
                captureSamplingStep(() => {
                  const captured = stepWorldState.capture();
                  const step = createCloudStepContext({
                    sequence: (stepSequence += 1),
                    turnContextSha256: cloudTurn.sha256,
                    attemptContextSha256: cloudAttempt.sha256,
                    activeTools,
                    worldState: captured.worldState,
                  });
                  return { step, modelMessages: captured.modelMessages };
                }),
              onToolOperationStarted: () => stepWorldState.recordActive(),
              onToolOperationUnavailable: () => stepWorldState.recordUnavailable(),
              remainingToolCalls: command.payload.budgets?.remainingToolCalls ?? 128,
              maximumToolOutputBytes: command.payload.budgets?.maximumToolOutputBytes ?? 65_536,
              toolOutputDirectory,
              ...(projectInstructions === undefined ? {} : { projectInstructions }),
              ...(downstreamTrace === undefined
                ? {}
                : {
                    traceparent: downstreamTrace.traceparent,
                    ...(downstreamTrace.tracestate === undefined
                      ? {}
                      : { tracestate: downstreamTrace.tracestate }),
                  }),
            }),
          ];
        },
        ...(this.#onPiSdkIsolationFailure === undefined
          ? {}
          : { onIsolationFailure: this.#onPiSdkIsolationFailure }),
      });
      onPiRunnerReady(runner);
      const result = await runner.run(command, publishEvent, signal);
      completedSuccessfully = true;
      return result;
    } finally {
      signal.removeEventListener("abort", abortSandbox);
      await fakeModel?.stop().catch(() => undefined);
      let cleanupError: unknown;
      if (activation !== undefined && completedSuccessfully && !signal.aborted) {
        await this.#manager
          .release(
            activation.activationId,
            toolAssignment,
            retainedWorkspaceRevision === undefined
              ? { kind: "destroy" }
              : { kind: "keep_warm", workspaceRevision: retainedWorkspaceRevision },
          )
          .catch((error: unknown) => {
            cleanupError = error;
          });
      } else {
        await stopSandbox().catch((error: unknown) => {
          cleanupError = error;
        });
      }
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
