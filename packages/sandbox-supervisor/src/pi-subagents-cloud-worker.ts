import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";

type WorkerInput = Readonly<{
  toolCallId: string;
  arguments: Record<string, unknown>;
  parentSessionId: string;
  model?: Readonly<{ provider: string; id: string }>;
  thinkingLevel?: string;
}>;
type ProviderResponse = Readonly<{
  type: "provider.response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  message?: string;
}>;
type ExternalJobStartInput = Readonly<{
  prompt: string;
  promptDigest: string;
  cwd: string;
  runId: string;
  stepIndex: number;
  agent: string;
  options: Record<string, unknown>;
  sessionId?: string;
}>;

const ISOLATED_WORKSPACE_TASK_PREFIX = "[pi-cloud-workspace-mode:isolated]\n";

const input = workerData as WorkerInput;
const cloudShimPath = fileURLToPath(new URL("./pi-subagents-cloud-shim.cjs", import.meta.url));
if (parentPort === null) throw new Error("Pi subagent cloud Worker requires a parent port");
const abort = new AbortController();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const activeProviderJobs = new Set<string>();
const completedCloudResults = new Map<string, { stepIndex: number; output: string }>();
const blockedCloudResults = new Map<
  string,
  {
    stepIndex: number;
    requestId: string;
    reason: string;
    message: string;
  }
>();

function progress(text: string, details: Record<string, unknown>): void {
  parentPort!.postMessage({
    type: "progress",
    result: { content: [{ type: "text", text }], details },
  });
}

parentPort.on("message", (message: ProviderResponse | { type: "abort" }) => {
  if (message.type === "abort") {
    void Promise.allSettled(
      [...activeProviderJobs].map((providerJobId) => request("cancel", { providerJobId })),
    ).finally(() => abort.abort(new Error("Subagent execution was cancelled")));
    return;
  }
  const requestState = pending.get(message.requestId);
  if (requestState === undefined) return;
  pending.delete(message.requestId);
  if (message.ok) requestState.resolve(message.result);
  else requestState.reject(new Error(message.message ?? "Subagent provider request failed"));
});

function request(operation: string, payload: Record<string, unknown>): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise });
    parentPort!.postMessage({ type: "provider.request", requestId, operation, ...payload });
  });
}

function prepareAgentDir(): {
  agentDir: string;
  stateDir: string;
  shimPath: string;
  socketPath: string;
} {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cloud-subagent-agent-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-cloud-subagent-state-"));
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "subagent", "config.json"),
    `${JSON.stringify({ asyncByDefault: false, defaultSubagentContext: "fresh", maxSubagentDepth: 1 })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const socketPath = join(stateDir, "cloud-runner.sock");
  return { agentDir, stateDir, shimPath: cloudShimPath, socketPath };
}

function parseChildInvocation(value: unknown): ExternalJobStartInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud Subagent shim request was invalid");
  }
  const requestValue = value as { args?: unknown; env?: unknown };
  if (
    !Array.isArray(requestValue.args) ||
    requestValue.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error("Cloud Subagent shim arguments were invalid");
  }
  const args = requestValue.args as string[];
  const env =
    requestValue.env && typeof requestValue.env === "object" && !Array.isArray(requestValue.env)
      ? (requestValue.env as Record<string, unknown>)
      : {};
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  const valueFlags = new Set([
    "--mode",
    "--session",
    "--session-dir",
    "--model",
    "--thinking",
    "--tools",
    "--extension",
    "--system-prompt",
    "--append-system-prompt",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index]!;
    if (!candidate.startsWith("-")) {
      positionals.push(candidate);
      continue;
    }
    if (!valueFlags.has(candidate)) continue;
    const selected = args[index + 1];
    if (selected === undefined) throw new Error(`Cloud Subagent flag ${candidate} has no value`);
    const existing = values.get(candidate) ?? [];
    existing.push(selected);
    values.set(candidate, existing);
    index += 1;
  }
  const taskArgument = positionals.at(-1);
  if (taskArgument === undefined) throw new Error("Cloud Subagent task was missing");
  let prompt = taskArgument.startsWith("@")
    ? readFileSync(taskArgument.slice(1), "utf8")
    : taskArgument;
  // pi-subagents normally asks a local child process to mirror its final
  // answer into a host-side output file. A cloud child cannot and must not
  // write outside /workspace; its native PostgreSQL Session result is already
  // returned through the provider bridge. Remove only that local transport
  // instruction while preserving the task and acceptance contract.
  prompt = prompt.replace(
    /\n---\n\*\*Output:\*\*\nWrite your findings to exactly this path:[^\n]*\nThis path is authoritative for this run\.\nIgnore any other output filename or output path mentioned elsewhere,[^\n]*\n?/u,
    "\n",
  );
  const isolationMarker = prompt.indexOf(ISOLATED_WORKSPACE_TASK_PREFIX);
  const isolatedWorkspace = isolationMarker >= 0;
  if (isolatedWorkspace) {
    prompt = `${prompt.slice(0, isolationMarker)}${prompt.slice(
      isolationMarker + ISOLATED_WORKSPACE_TASK_PREFIX.length,
    )}`;
  }
  const systemPromptFiles = [
    ...(values.get("--system-prompt") ?? []),
    ...(values.get("--append-system-prompt") ?? []),
  ];
  const systemPrompt = systemPromptFiles.map((file) => readFileSync(file, "utf8")).join("\n\n");
  const explicitTools = values.get("--tools")?.at(-1);
  let requestedToolCapabilities = args.includes("--no-tools")
    ? []
    : explicitTools === undefined
      ? ["read", "write", "edit", "bash"]
      : explicitTools
          .split(",")
          .map((tool) => tool.trim())
          .filter((tool) => ["read", "write", "edit", "bash"].includes(tool));
  const agent =
    typeof env.PI_SUBAGENT_CHILD_AGENT === "string" ? env.PI_SUBAGENT_CHILD_AGENT : "delegate";
  if (agent === "oracle" || agent === "gpt-pro") requestedToolCapabilities = [];
  if (agent === "scout" || agent === "researcher" || agent === "reviewer") {
    requestedToolCapabilities = requestedToolCapabilities.filter(
      (tool) => tool === "read" || tool === "bash",
    );
  }
  const runId = typeof env.PI_SUBAGENT_RUN_ID === "string" ? env.PI_SUBAGENT_RUN_ID : randomUUID();
  const childIndex = Number(env.PI_SUBAGENT_CHILD_INDEX ?? 0);
  const stepIndex = Number.isSafeInteger(childIndex) && childIndex >= 0 ? childIndex : 0;
  const contextMode =
    agent === "scout" || agent === "researcher"
      ? "fresh"
      : values.has("--session")
        ? "fork"
        : "fresh";
  return {
    prompt,
    promptDigest: createHash("sha256").update(prompt, "utf8").digest("hex"),
    cwd: directoriesForBridge?.stateDir ?? tmpdir(),
    runId,
    stepIndex,
    agent,
    options: {
      contextMode,
      workspaceMode:
        requestedToolCapabilities.length === 0
          ? "none"
          : isolatedWorkspace
            ? "isolated"
            : "shared_serialized",
      requestedToolCapabilities,
      ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
      ...(values.get("--model")?.at(-1) === undefined
        ? {}
        : { model: values.get("--model")!.at(-1) }),
      ...(values.get("--thinking")?.at(-1) === undefined
        ? {}
        : { thinkingLevel: values.get("--thinking")!.at(-1) }),
    },
    sessionId: input.parentSessionId,
  };
}

function cloudWorkflowScript(script: string, defaultIsolated: boolean): string {
  const marker = JSON.stringify(ISOLATED_WORKSPACE_TASK_PREFIX);
  return [
    `const __piCloudDefaultIsolated = ${String(defaultIsolated)};`,
    `const __piCloudTaskMarker = ${marker};`,
    "const __piCloudChild = (spec) => {",
    "  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;",
    "  const isolated = spec.worktree === undefined ? __piCloudDefaultIsolated : spec.worktree === true;",
    "  const task = isolated && typeof spec.task === 'string' ? __piCloudTaskMarker + spec.task : spec.task;",
    "  return { ...spec, worktree: false, ...(task === undefined ? {} : { task }) };",
    "};",
    "const __piCloudRuns = Object.freeze({",
    "  run: (key, spec) => runs.run(key, __piCloudChild(spec)),",
    "  all: (specs) => runs.all(specs.map(__piCloudChild)),",
    "  status: (keyOrRunId) => runs.status(keyOrRunId),",
    "  ref: (result) => runs.ref(result),",
    "  refs: (results) => runs.refs(results),",
    "});",
    `return await (async (runs) => { ${script}\n})(__piCloudRuns);`,
  ].join("\n");
}

function structuredChildWorkflowScript(
  argumentsValue: Record<string, unknown>,
): string | undefined {
  if (typeof argumentsValue.agent !== "string" || argumentsValue.agent.trim() === "") {
    return undefined;
  }
  const child = Object.fromEntries(
    ["agent", "task", "resume", "worktree", "model", "thinking", "tools", "context", "cwd"]
      .filter((key) => argumentsValue[key] !== undefined)
      .map((key) => [key, argumentsValue[key]]),
  );
  return `return runs.run("main", ${JSON.stringify(child)});`;
}

let directoriesForBridge: ReturnType<typeof prepareAgentDir> | undefined;

async function waitForCloudResult(
  startInput: ExternalJobStartInput,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const started = (await request("start", { input: startInput })) as {
    providerJobId: string;
    state: string;
  };
  activeProviderJobs.add(started.providerJobId);
  progress(`Subagent ${startInput.agent} 已进入云端 Worker 队列。`, {
    state: started.state,
    agent: startInput.agent,
    stepIndex: startInput.stepIndex,
    elapsedMs: Date.now() - startedAt,
  });
  if (abort.signal.aborted) {
    await request("cancel", { providerJobId: started.providerJobId }).catch(() => undefined);
    activeProviderJobs.delete(started.providerJobId);
    throw abort.signal.reason;
  }
  let state = started.state;
  let previousState = state;
  let latestCoordination:
    | {
        requestId: string;
        reason: string;
        message: string;
        expectsReply: boolean;
      }
    | undefined;
  let latestCoordinationId: string | undefined;
  const deadline = Date.now() + 120_000;
  while (!new Set(["completed", "failed", "stopped", "blocked"]).has(state)) {
    if (abort.signal.aborted) throw abort.signal.reason;
    if (Date.now() >= deadline)
      throw new Error("Cloud Subagent timed out while waiting for its Child Run");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    const status = (await request("status", { providerJobId: started.providerJobId })) as {
      state: string;
      coordinationRequest?: {
        requestId: string;
        reason: string;
        message: string;
        expectsReply: boolean;
      };
    };
    state = status.state;
    latestCoordination = status.coordinationRequest;
    if (latestCoordination !== undefined && latestCoordination.requestId !== latestCoordinationId) {
      latestCoordinationId = latestCoordination.requestId;
      progress(
        latestCoordination.expectsReply
          ? `Subagent ${startInput.agent} 正在等待父 Agent 决策：${latestCoordination.message}`
          : `Subagent ${startInput.agent}：${latestCoordination.message}`,
        {
          state,
          agent: startInput.agent,
          stepIndex: startInput.stepIndex,
          coordinationRequest: latestCoordination,
          elapsedMs: Date.now() - startedAt,
        },
      );
    }
    if (state !== previousState) {
      previousState = state;
      progress(
        state === "running"
          ? `Subagent ${startInput.agent} 正在执行。`
          : `Subagent ${startInput.agent} 状态：${state}`,
        {
          state,
          agent: startInput.agent,
          stepIndex: startInput.stepIndex,
          elapsedMs: Date.now() - startedAt,
        },
      );
    }
  }
  if (state === "blocked" && latestCoordination?.expectsReply === true) {
    blockedCloudResults.set(started.providerJobId, {
      stepIndex: startInput.stepIndex,
      requestId: latestCoordination.requestId,
      reason: latestCoordination.reason,
      message: latestCoordination.message,
    });
    return {
      providerJobId: started.providerJobId,
      state: "blocked",
      blockingJobId: latestCoordination.requestId,
      failureMessage: latestCoordination.message,
    };
  }
  try {
    const result = (await request("result", { providerJobId: started.providerJobId })) as Record<
      string,
      unknown
    >;
    if (typeof result.output === "string" && result.output.trim() !== "") {
      completedCloudResults.set(started.providerJobId, {
        stepIndex: startInput.stepIndex,
        output: result.output.trim(),
      });
    }
    progress(`Subagent ${startInput.agent} 已结束。`, {
      state: result.state,
      agent: startInput.agent,
      stepIndex: startInput.stepIndex,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } finally {
    activeProviderJobs.delete(started.providerJobId);
  }
}

async function startShimBridge(socketPath: string): Promise<Server> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void waitForCloudResult(parseChildInvocation(JSON.parse(line)))
        .then((result) => socket.end(`${JSON.stringify(result)}\n`))
        .catch((error: unknown) =>
          socket.end(
            `${JSON.stringify({
              state: "failed",
              failureMessage: error instanceof Error ? error.message : String(error),
            })}\n`,
          ),
        );
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  return server;
}

async function main(): Promise<void> {
  progress("正在准备 pi-subagents 云端编排器。", { state: "preparing" });
  const directories = prepareAgentDir();
  directoriesForBridge = directories;
  process.env.PI_CODING_AGENT_DIR = directories.agentDir;
  process.env.PI_SUBAGENTS_TEMP_ROOT = directories.stateDir;
  process.env.PI_SUBAGENT_PI_BINARY = directories.shimPath;
  process.env.PI_CLOUD_SUBAGENT_BRIDGE_SOCKET = directories.socketPath;
  const bridge = await startShimBridge(directories.socketPath);
  const extensionSpecifier: string = "pi-subagents";
  const extensionModule = await import(extensionSpecifier);
  const registerPiSubagents = (extensionModule as { default: ExtensionFactory }).default;
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider("pi-cloud-subagent-host", {
    baseUrl: "http://127.0.0.1",
    api: "openai-completions",
    models: [
      {
        id: "orchestrator",
        name: "orchestrator",
        reasoning: false,
        input: ["text"],
        contextWindow: 16_384,
        maxTokens: 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey("pi-cloud-subagent-host", "not-used");
  const model = modelRuntime.getModel("pi-cloud-subagent-host", "orchestrator");
  if (model === undefined) throw new Error("Subagent extension host model was unavailable");
  const sessionManager = SessionManager.create(
    directories.stateDir,
    join(directories.stateDir, "compatibility-sessions"),
    { id: input.parentSessionId },
  );
  sessionManager.appendMessage({
    role: "user",
    content: "PiCloud owns the parent context in PostgreSQL; fork it through the cloud runner.",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Cloud compatibility boundary ready." }],
    api: "openai-completions",
    provider: "pi-cloud",
    model: "compatibility",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const loader = new DefaultResourceLoader({
    cwd: directories.stateDir,
    agentDir: directories.agentDir,
    eventBus: createEventBus(),
    extensionFactories: [{ name: "pi-subagents", factory: registerPiSubagents }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directories.stateDir,
    agentDir: directories.agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader: loader,
    sessionManager,
    sessionStartEvent: { type: "session_start", reason: "new" },
    noTools: "builtin",
  });
  await session.bindExtensions({ mode: "print" });
  try {
    const registered = session.extensionRunner
      .getAllRegisteredTools()
      .find((tool) => tool.definition.name === "subagent");
    if (registered === undefined) throw new Error("pi-subagents Tool was unavailable");
    const tool = wrapRegisteredTool(registered, session.extensionRunner);
    if (input.arguments.action === "list") {
      const listed = await tool.execute(input.toolCallId, { action: "list" }, abort.signal);
      parentPort!.postMessage({ type: "result", result: listed });
      return;
    }
    if (typeof input.arguments.action === "string") {
      throw new Error(
        "Cloud subagent management actions are unavailable across Worker replacement; start a child or workflow instead",
      );
    }
    const requestedScript =
      typeof input.arguments.workflowScript === "string"
        ? input.arguments.workflowScript
        : structuredChildWorkflowScript(input.arguments);
    if (requestedScript === undefined) {
      throw new Error("Cloud subagents require { agent, task } or a pi-subagents workflowScript");
    }
    const {
      agent: _structuredAgent,
      task: _structuredTask,
      resume: _structuredResume,
      ...workflowArguments
    } = input.arguments;
    const argumentsForCloud = {
      ...workflowArguments,
      workflowScript: cloudWorkflowScript(requestedScript, input.arguments.worktree === true),
      async: true,
      mission: false,
      chatProgress: "off",
      worktree: false,
    };
    const launched = await tool.execute(
      input.toolCallId,
      argumentsForCloud,
      abort.signal,
      (partial: AgentToolResult<unknown>) =>
        parentPort!.postMessage({ type: "progress", result: partial }),
    );
    const asyncId =
      typeof launched.details === "object" &&
      launched.details !== null &&
      "asyncId" in launched.details &&
      typeof launched.details.asyncId === "string"
        ? launched.details.asyncId
        : undefined;
    if (asyncId === undefined) {
      parentPort!.postMessage({ type: "result", result: launched });
      return;
    }
    const registeredWait = session.extensionRunner
      .getAllRegisteredTools()
      .find((candidate) => candidate.definition.name === "subagent_wait");
    if (registeredWait === undefined) throw new Error("pi-subagents wait Tool was unavailable");
    const waitTool = wrapRegisteredTool(registeredWait, session.extensionRunner);
    await waitTool.execute(
      `${input.toolCallId}:wait`,
      { id: asyncId, timeoutMs: 120_000 },
      abort.signal,
    );
    const blocked = [...blockedCloudResults.values()].sort(
      (left, right) => left.stepIndex - right.stepIndex,
    );
    if (blocked.length > 0) {
      parentPort!.postMessage({
        type: "result",
        result: {
          content: [
            {
              type: "text" as const,
              text: [
                "A cloud Subagent paused for supervisor input.",
                ...blocked.flatMap((request) => [
                  "",
                  `${request.requestId} · ${request.reason}`,
                  request.message,
                  `Reply with subagent_supervisor({ action: \"reply\", replyTo: \"${request.requestId}\", message: \"...\" }).`,
                ]),
              ].join("\n"),
            },
          ],
          details: { state: "blocked", requests: blocked },
        },
      });
      return;
    }
    const cloudOutput = [...completedCloudResults.values()]
      .sort((left, right) => left.stepIndex - right.stepIndex)
      .map((result) => result.output)
      .join("\n\n---\n\n")
      .trim();
    parentPort!.postMessage({
      type: "result",
      result: {
        content: [
          {
            type: "text" as const,
            text:
              cloudOutput === ""
                ? "Subagent workflow completed without a text result."
                : `Subagent workflow completed.\n\n${cloudOutput}`,
          },
        ],
        // The upstream launch/wait payload contains Worker-local paths,
        // async registry IDs and follow-up instructions that are invalid after
        // this cloud invocation is disposed. Keep only bounded terminal facts
        // in the model-visible result.
        details: {
          state: "completed",
          childCount: completedCloudResults.size,
        },
      },
    });
  } finally {
    session.dispose();
    await new Promise<void>((resolvePromise) => bridge.close(() => resolvePromise()));
    rmSync(directories.agentDir, { recursive: true, force: true });
    rmSync(directories.stateDir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  parentPort!.postMessage({
    type: "failure",
    message: error instanceof Error ? error.message : String(error),
  });
});
