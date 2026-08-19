import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createEventBus,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type ExternalJobStartInput = Readonly<{
  prompt: string;
  promptDigest: string;
  cwd: string;
  runId: string;
  stepIndex: number;
  agent: string;
  options: Record<string, unknown>;
  sessionId?: string;
}>;
export type ExternalJobHandle = Readonly<{
  providerJobId: string;
  state: "queued" | "running" | "completed" | "failed" | "stopped" | "blocked";
  handleUrl?: string;
  conversationUrl?: string;
  failureCode?: string;
  failureMessage?: string;
  blockingJobId?: string;
  coordinationRequest?: Readonly<{
    requestId: string;
    reason: "need_decision" | "interview_request" | "progress_update";
    message: string;
    expectsReply: boolean;
  }>;
}>;
export type ExternalJobResult = ExternalJobHandle &
  Readonly<{ output?: string; artifactPath?: string }>;

export type PiSubagentCloudCoordinator = Readonly<{
  start(
    input: ExternalJobStartInput,
    parentToolCallId: string,
  ): Promise<ExternalJobHandle> | ExternalJobHandle;
  status(providerJobId: string): Promise<ExternalJobHandle> | ExternalJobHandle;
  result(providerJobId: string): Promise<ExternalJobResult> | ExternalJobResult;
  reattach(providerJobId: string): Promise<ExternalJobHandle> | ExternalJobHandle;
  cancel(providerJobId: string): Promise<ExternalJobHandle> | ExternalJobHandle;
}>;

export type PiSubagentCloudToolContext = Readonly<{
  parentSessionId: string;
  model?: Readonly<{ provider: string; id: string }>;
  thinkingLevel?: string;
}>;

type Contract = Pick<ToolDefinition, "name" | "label" | "description" | "parameters">;
type WorkerProviderRequest = Readonly<{
  type: "provider.request";
  requestId: string;
  operation: "start" | "status" | "result" | "reattach" | "cancel";
  input?: ExternalJobStartInput;
  providerJobId?: string;
}>;
type WorkerMessage =
  | WorkerProviderRequest
  | Readonly<{ type: "progress"; result: AgentToolResult<unknown> }>
  | Readonly<{ type: "result"; result: AgentToolResult<unknown> }>
  | Readonly<{ type: "failure"; message: string }>;

let contractPromise: Promise<Contract> | undefined;

async function loadContract(): Promise<Contract> {
  if (contractPromise !== undefined) return contractPromise;
  contractPromise = (async () => {
    const packageSpecifier: string = "pi-subagents";
    const imported = (await import(packageSpecifier)) as { default: ExtensionFactory };
    const agentDir = await mkdtemp(resolve(tmpdir(), "pi-cloud-subagents-contract-"));
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      eventBus: createEventBus(),
      extensionFactories: [{ name: "pi-subagents", factory: imported.default }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const errors = loader.getExtensions().errors;
    if (errors.length > 0) {
      throw new Error(`pi-subagents contract failed to load: ${errors[0]!.error}`);
    }
    const registered = loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.values()])
      .find((tool) => tool.definition.name === "subagent");
    if (registered === undefined) throw new Error("pi-subagents did not register its Tool");
    const definition = registered.definition;
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
    };
  })();
  return contractPromise;
}

function failure(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: message }], details: { error: message } };
}

async function executeProviderRequest(
  coordinator: PiSubagentCloudCoordinator,
  request: WorkerProviderRequest,
  parentToolCallId: string,
): Promise<ExternalJobHandle | ExternalJobResult> {
  switch (request.operation) {
    case "start":
      if (request.input === undefined) throw new Error("Subagent provider start input is missing");
      return coordinator.start(request.input, parentToolCallId);
    case "status":
      if (request.providerJobId === undefined)
        throw new Error("Subagent provider job ID is missing");
      return coordinator.status(request.providerJobId);
    case "result":
      if (request.providerJobId === undefined)
        throw new Error("Subagent provider job ID is missing");
      return coordinator.result(request.providerJobId);
    case "reattach":
      if (request.providerJobId === undefined)
        throw new Error("Subagent provider job ID is missing");
      return coordinator.reattach(request.providerJobId);
    case "cancel":
      if (request.providerJobId === undefined)
        throw new Error("Subagent provider job ID is missing");
      return coordinator.cancel(request.providerJobId);
  }
}

export async function createPiSubagentsCloudTool(options: {
  context: PiSubagentCloudToolContext;
  coordinator: PiSubagentCloudCoordinator;
}): Promise<AgentTool> {
  const contract = await loadContract();
  return {
    ...contract,
    execute: async (toolCallId, rawArguments, signal, onUpdate) => {
      if (signal?.aborted) return failure("Subagent execution was cancelled before admission");
      return new Promise<AgentToolResult<unknown>>((resolvePromise) => {
        const worker = new Worker(new URL("./pi-subagents-cloud-worker.ts", import.meta.url), {
          execArgv: ["--import", "tsx"],
          workerData: {
            toolCallId,
            arguments: rawArguments,
            parentSessionId: options.context.parentSessionId,
            model: options.context.model,
            thinkingLevel: options.context.thinkingLevel,
          },
        });
        let settled = false;
        let settling = false;
        let aborting = false;
        const admittedJobs = new Set<string>();
        const cancelledJobs = new Set<string>();
        const providerOperations = new Set<Promise<unknown>>();
        const finalize = (result: AgentToolResult<unknown>) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          void worker.terminate();
          resolvePromise(result);
        };
        const cancelAdmitted = async (): Promise<void> => {
          while (providerOperations.size > 0) {
            await Promise.allSettled([...providerOperations]);
          }
          await Promise.allSettled(
            [...admittedJobs]
              .filter((providerJobId) => !cancelledJobs.has(providerJobId))
              .map(async (providerJobId) => {
                await options.coordinator.cancel(providerJobId);
                cancelledJobs.add(providerJobId);
              }),
          );
        };
        const settle = (result: AgentToolResult<unknown>) => {
          if (settled || settling) return;
          if (!aborting) {
            finalize(result);
            return;
          }
          settling = true;
          void cancelAdmitted().finally(() => finalize(result));
        };
        const abort = () => {
          aborting = true;
          worker.postMessage({ type: "abort" });
        };
        signal?.addEventListener("abort", abort, { once: true });
        worker.on("message", (message: WorkerMessage) => {
          if (message.type === "progress") {
            onUpdate?.(message.result);
            return;
          }
          if (message.type === "result") {
            settle(message.result);
            return;
          }
          if (message.type === "failure") {
            settle(failure(message.message));
            return;
          }
          const operation = executeProviderRequest(options.coordinator, message, toolCallId);
          providerOperations.add(operation);
          void operation
            .then((result) => {
              if (message.operation === "start") admittedJobs.add(result.providerJobId);
              if (message.operation === "cancel" && message.providerJobId !== undefined) {
                cancelledJobs.add(message.providerJobId);
              }
              worker.postMessage({
                type: "provider.response",
                requestId: message.requestId,
                ok: true,
                result,
              });
            })
            .catch((error: unknown) =>
              worker.postMessage({
                type: "provider.response",
                requestId: message.requestId,
                ok: false,
                message: error instanceof Error ? error.message : String(error),
              }),
            )
            .finally(() => providerOperations.delete(operation));
        });
        worker.on("error", (error) => settle(failure(`Subagent host failed: ${error.message}`)));
        worker.on("exit", (code) => {
          if (!settled) settle(failure(`Subagent host exited before returning a result (${code})`));
        });
      });
    },
  };
}
