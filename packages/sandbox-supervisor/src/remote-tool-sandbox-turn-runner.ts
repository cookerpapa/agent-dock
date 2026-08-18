import { FAKE_MODEL_API_KEY, FakeModelServer } from "@pi-cloud/fake-model-server";
import { activeTraceCarrier, withSpan, type PiCloudMetrics } from "@pi-cloud/observability";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type ExecuteTurnCommandMessage,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxCreateRequest,
  type ToolSandboxCreateResponse,
  type WorkspacePatch,
} from "@pi-cloud/protocol";
import {
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  parsePersistentVolumeReference,
  parseWorkspaceSnapshot,
} from "@pi-cloud/workspace-runtime";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SupervisorTurnRunner } from "./local-sandbox-supervisor.ts";
import { PiTurnError, type PiEventPublisher, type PiTurnResult } from "./pi-turn-runtime.ts";
import {
  PiCloudTurnRunner,
  type PiCloudSessionHandle,
  type PiCloudTurnRunnerOptions,
} from "./pi-cloud-turn-runner.ts";
import {
  PiSettlementGateController,
  settlementGatePolicyFromCommand,
} from "./pi-settlement-gate.ts";
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
import { createTrustedRemoteAgentTools } from "./trusted-remote-tools-extension.ts";
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
  if (parsePersistentVolumeReference(snapshot) !== undefined) {
    // The persistent-volume reference contains a bounded file index, not file
    // bytes. The trusted Runner reads project instructions only after the
    // volume is attached through the Tool boundary.
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
  return `${content}${file.content.byteLength > bounded.byteLength ? "\n[AGENTS.md truncated by PiCloud]" : ""}`;
}

export interface ToolBrokerBoundary {
  create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse>;
  capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<ToolSandboxCaptureResponse>;
  release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition:
      | { kind: "keep_warm"; workspaceRevision: string }
      | { kind: "keep_persistent"; workspaceRevision: string }
      | { kind: "destroy" },
  ): Promise<{ retained: boolean }>;
  stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void>;
  operationUrlFor(activationId: string): string;
}

export type RemoteToolSandboxTurnRunnerOptions = {
  broker: ToolBrokerBoundary;
  runtimeIdentity: SandboxRuntimeIdentity;
  trustedWorkspaceDirectory: string;
  scenario?: AgentTurnScenario | AgentTurnScenarioResolver;
  modelRuntimeLeaseResolver?: TrustedModelRuntimeLeaseResolver;
  workspaceSeedResolver?: AgentWorkspaceSeedResolver;
  checkpointStore?: SandboxCheckpointStore;
  openAgentSession: (command: ExecuteTurnCommandMessage) => Promise<PiCloudSessionHandle>;
  createOrchestrationTools?: (
    command: ExecuteTurnCommandMessage,
    context: Readonly<{
      activation?: Readonly<{ activationId: string; assignment: ToolSandboxAssignment }>;
    }>,
  ) => Promise<readonly AgentTool[]> | readonly AgentTool[];
  runAttemptPhaseObserver?: RunAttemptPhaseObserver;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  idGenerator?: () => string;
  metrics?: PiCloudMetrics;
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
  readonly #broker: ToolBrokerBoundary;
  readonly #runtimeIdentity: SandboxRuntimeIdentity;
  readonly #trustedWorkspaceDirectory: string;
  readonly #scenario: AgentTurnScenario | AgentTurnScenarioResolver;
  readonly #modelRuntimeLeaseResolver: TrustedModelRuntimeLeaseResolver | undefined;
  readonly #workspaceSeedResolver: AgentWorkspaceSeedResolver | undefined;
  readonly #checkpointStore: SandboxCheckpointStore | undefined;
  readonly #openAgentSession: RemoteToolSandboxTurnRunnerOptions["openAgentSession"];
  readonly #createOrchestrationTools: RemoteToolSandboxTurnRunnerOptions["createOrchestrationTools"];
  readonly #runAttemptPhaseObserver: RunAttemptPhaseObserver | undefined;
  readonly #requestTimeoutMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
  readonly #idGenerator: () => string;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #activePiRunners = new Map<
    string,
    {
      ready: Promise<PiCloudTurnRunner>;
      resolve: (runner: PiCloudTurnRunner) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(options: RemoteToolSandboxTurnRunnerOptions) {
    this.#broker = options.broker;
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#trustedWorkspaceDirectory = resolve(options.trustedWorkspaceDirectory);
    this.#scenario = options.scenario ?? "java_repair";
    this.#modelRuntimeLeaseResolver = options.modelRuntimeLeaseResolver;
    this.#workspaceSeedResolver = options.workspaceSeedResolver;
    this.#checkpointStore = options.checkpointStore;
    this.#openAgentSession = options.openAgentSession;
    this.#createOrchestrationTools = options.createOrchestrationTools;
    this.#runAttemptPhaseObserver = options.runAttemptPhaseObserver;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#turnTimeoutMs = options.turnTimeoutMs;
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#metrics = options.metrics;
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
    let resolveRunner!: (runner: PiCloudTurnRunner) => void;
    let rejectRunner!: (error: Error) => void;
    const ready = new Promise<PiCloudTurnRunner>((resolvePromise, rejectPromise) => {
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
        serviceName: "pi-cloud-trusted-runner",
        name: "run.execute",
        ...(command.payload.traceContext === undefined
          ? {}
          : { parent: command.payload.traceContext }),
        attributes: {
          "pi_cloud.run.id": command.payload.runId,
          "pi_cloud.attempt.id": command.payload.attemptId,
          "pi_cloud.session.id": command.payload.sessionId,
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
    onPiRunnerReady: (runner: PiCloudTurnRunner) => void,
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
    const toolFree = cloudTurn.context.tools.names.length === 0;

    const usesEmbeddedFake =
      command.payload.model.provider === "pi-cloud-fake" &&
      command.payload.model.modelId === "pi-cloud-fake";
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
        stopPromise = this.#broker.stop(activation.activationId, toolAssignment).then(
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
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: this.#idGenerator(),
        assignment: toolAssignment,
        turnContextSha256: cloudTurn.sha256,
        attemptContextSha256: cloudAttempt.sha256,
        allowedTools: cloudTurn.context.tools.names,
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
      if (!toolFree) {
        const createStartedAt = performance.now();
        try {
          activation = await this.#broker.create(createRequest);
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

      const resolveModelRuntime: PiCloudTurnRunnerOptions["resolveModelRuntime"] = (model) =>
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
      const onSettled: NonNullable<PiCloudTurnRunnerOptions["onSettled"]> = async () => {
        if (activation === undefined) {
          if (toolFree) {
            retainedWorkspaceRevision = loadedCheckpoint?.workspaceRevision;
            return;
          }
          throw new PiTurnError(
            "tool_sandbox_unavailable",
            "Tool Sandbox was unavailable at settlement",
            true,
          );
        }
        const checkpointStartedAt = performance.now();
        const captured = await this.#broker
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
        if (captured.type === "tool_sandbox.unused") {
          retainedWorkspaceRevision = loadedCheckpoint?.workspaceRevision;
          this.#metrics?.checkpointDuration.observe(
            { outcome: "completed" },
            (performance.now() - checkpointStartedAt) / 1_000,
          );
          return;
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
        if (this.#checkpointStore !== undefined) {
          try {
            const saved = await this.#checkpointStore.save(
              command,
              loadedCheckpoint?.revision ?? null,
              {
                workspace: decodeWorkspaceSnapshotBlob(captured.workspace),
                environment: captured.environment,
                ...(captured.workspacePatch === undefined
                  ? {}
                  : { workspacePatch: captured.workspacePatch }),
              },
            );
            capturedPatch = captured.workspacePatch;
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
        } else {
          capturedPatch = captured.workspacePatch;
          retainedWorkspaceRevision = captured.workspace.sha256;
        }
      };
      const activeSandbox = activation;
      const settlementPolicy = settlementGatePolicyFromCommand(command);
      const settlementGate =
        settlementPolicy === undefined
          ? undefined
          : new PiSettlementGateController(settlementPolicy);
      const orchestrationTools =
        (await this.#createOrchestrationTools?.(command, {
          ...(activeSandbox === undefined
            ? {}
            : {
                activation: {
                  activationId: activeSandbox.activationId,
                  assignment: toolAssignment,
                },
              }),
        })) ?? ([] as readonly AgentTool[]);
      const commonRunnerOptions = {
        resolveModelRuntime,
        openSession: this.#openAgentSession,
        collectWorkspacePatch: () => capturedPatch,
        ...(this.#checkpointStore?.saveToolOutput === undefined
          ? {}
          : {
              persistToolOutputArtifact: (output: { toolCallId: string; bytes: Uint8Array }) =>
                this.#checkpointStore!.saveToolOutput!(command, output),
            }),
        sandboxContinuity: {
          activationId: activeSandbox?.activationId ?? command.payload.attemptId,
          continuity: activeSandbox?.continuity ?? "cold_restore",
          environmentSha256: cloudTurn.environmentSha256,
          committedWorkspaceRevision: loadedCheckpoint?.workspaceRevision ?? null,
          toolPolicySha256: cloudTurn.toolPolicySha256,
        },
        onSettled,
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
      const runner = new PiCloudTurnRunner({
        ...commonRunnerOptions,
        createAgentTools: ({ toolOutputDirectory, stepWorldState, captureSamplingStep }) => {
          if (activeSandbox === undefined) {
            return {
              tools: [...orchestrationTools],
              async systemPrompt(base: string) {
                return orchestrationTools.length === 0
                  ? base
                  : [
                      base,
                      "You may delegate substantial independent work through the subagent Tool. " +
                        "Use stable workflow keys and inspect every returned result.",
                    ].join("\n");
              },
              async transformContext(messages) {
                return messages;
              },
              async transformHeaders(headers = {}) {
                return headers;
              },
            };
          }
          let stepSequence = 0;
          const remoteTools = createTrustedRemoteAgentTools({
            operationUrl: this.#broker.operationUrlFor(activeSandbox.activationId),
            activationId: activeSandbox.activationId,
            capability: activeSandbox.capability,
            turnContextSha256: cloudTurn.sha256,
            attemptContextSha256: cloudAttempt.sha256,
            allowedTools: cloudTurn.context.tools.names,
            captureStepContext: (activeTools, purpose = "agent") =>
              captureSamplingStep(
                async () => {
                  const captured = await stepWorldState.capture();
                  const step = createCloudStepContext({
                    sequence: (stepSequence += 1),
                    turnContextSha256: cloudTurn.sha256,
                    attemptContextSha256: cloudAttempt.sha256,
                    allowedTools: cloudTurn.context.tools.names,
                    activeTools,
                    worldState: captured.worldState,
                  });
                  return { step, modelMessages: captured.modelMessages };
                },
                { publishEvent: purpose === "agent" },
              ),
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
          });
          if (orchestrationTools.length === 0) return remoteTools;
          return {
            ...remoteTools,
            tools: [...remoteTools.tools, ...orchestrationTools],
            async systemPrompt(base: string) {
              return [
                await remoteTools.systemPrompt(base),
                "You may delegate substantial independent work through the subagent Tool. " +
                  "Use stable workflow keys, keep one shared Workspace writer, and inspect every returned result.",
              ].join("\n");
            },
          };
        },
        ...(settlementGate === undefined
          ? {}
          : {
              observeEvent: (event) => {
                if (
                  event.type !== "compaction_start" &&
                  event.type !== "compaction_end" &&
                  event.type !== "auto_retry_start" &&
                  event.type !== "auto_retry_end"
                ) {
                  settlementGate.observe(event);
                }
              },
              prepareFollowUp: () => settlementGate.prepareFollowUp(),
            }),
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
        await this.#broker
          .release(
            activation.activationId,
            toolAssignment,
            retainedWorkspaceRevision === undefined
              ? { kind: "destroy" }
              : {
                  kind:
                    command.payload.sandboxRetention === "persistent"
                      ? "keep_persistent"
                      : "keep_warm",
                  workspaceRevision: retainedWorkspaceRevision,
                },
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
