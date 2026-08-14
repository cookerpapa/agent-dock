import {
  Agent,
  Closed,
  DEFAULT_COMPACTION_SETTINGS,
  InvalidLane,
  InvalidMessage,
  LaneBusy,
  LaneExists,
  MissingIdentities,
  NoActiveOperation,
  NoActiveRun,
  NothingToCompact,
  NothingToResume,
  UnknownQueueItem,
  UnknownSkill,
  UnknownTarget,
  UnknownTemplate,
  HarnessClosed,
  buildSessionContext,
  buildContextEntries,
  collectEntriesForBranchSummary,
  compact as compactSession,
  convertToLlm,
  err,
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  generateBranchSummary,
  ok,
  prepareCompaction,
  shouldCompact,
  sessionEntryToContextMessages,
  type AbortResult,
  type ActionInfo,
  type AgentEvent,
  type AgentLane,
  type AgentMessage,
  type AgentToolResult,
  type CompactionResult,
  type CompactionEntry,
  type CompactionPreparation,
  type CompactionSettings,
  type CancelQueuedResult,
  type CreateLaneResult,
  type BranchSummaryEntry,
  type Entry,
  type EntryProjector,
  type HarnessTool,
  type HookName,
  type JsonValue,
  type LaneInfo,
  type LaneSnapshot,
  type NavigateOptions,
  type NavigationResult,
  type ProvisionedEntry,
  type QueueMode,
  type QueueResult,
  type RecordUsageResult,
  type Resources,
  type ResumeResult,
  type RunResult,
  type Session,
  type SessionSnapshot,
  type SessionTree,
  type StreamFn,
  type SuspendedOperation,
  type ThinkingLevel,
  type WatchHandle,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  Models,
  RetryPolicy,
  SimpleStreamOptions,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";

export type DurableAgentExecutionScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
}>;

/**
 * One opaque authority for every effect produced by a cloud Agent Run.
 *
 * The Harness deliberately does not expose lease IDs or fencing tokens. The
 * provider owns their representation and must reject stale authority at the
 * actual storage/Tool effect boundary.
 */
export interface DurableAgentExecutionAuthority {
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableAgentExecutionAuthorityProvider {
  acquire(scope: DurableAgentExecutionScope): Promise<DurableAgentExecutionAuthority>;
}

/** Binds a pre-created authority to exactly one Harness operation. */
export class FixedDurableAgentExecutionAuthorityProvider implements DurableAgentExecutionAuthorityProvider {
  readonly #scope: DurableAgentExecutionScope;
  readonly #authority: DurableAgentExecutionAuthority;
  #acquired = false;

  constructor(scope: DurableAgentExecutionScope, authority: DurableAgentExecutionAuthority) {
    this.#scope = scope;
    this.#authority = authority;
  }

  async acquire(scope: DurableAgentExecutionScope): Promise<DurableAgentExecutionAuthority> {
    if (
      this.#acquired ||
      scope.tenantId !== this.#scope.tenantId ||
      scope.sessionId !== this.#scope.sessionId ||
      scope.runId !== this.#scope.runId ||
      scope.attemptId !== this.#scope.attemptId
    ) {
      throw new Error("Durable Agent execution authority scope is stale");
    }
    this.#acquired = true;
    await this.#authority.assertCurrent();
    return this.#authority;
  }
}

export type DurableAgentHarnessOptions = {
  session: Session;
  authorityProvider: DurableAgentExecutionAuthorityProvider;
  scope: DurableAgentExecutionScope;
  model: Model<Api>;
  /** Pi Models is preferred. streamFn remains supported by the production Model Gateway adapter. */
  models?: Models;
  streamFn?: StreamFn;
  systemPrompt: string | (() => string | Promise<string>);
  tools?: readonly HarnessTool[];
  activeToolNames?: readonly string[];
  resources?: Resources;
  thinkingLevel?: ThinkingLevel;
  streamOptions?: SimpleStreamOptions;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: "sequential" | "parallel";
  drive?: "automatic" | "manual";
  toProviderMessages?: (messages: AgentMessage[]) => Promise<Message[]> | Message[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  entryProjectors?: Record<string, EntryProjector>;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  idGenerator?: () => string;
};

type OperationKind = "run" | "compaction" | "navigation";

type DurableRunContext = Readonly<{
  originalPrompt: AgentMessage[];
  systemPromptOverride?: string;
  resumeData?: Record<string, JsonValue>;
}>;

type ActiveOperation = {
  id: string;
  kind: OperationKind;
  authority: DurableAgentExecutionAuthority;
  agent?: Agent;
  promise: Promise<unknown>;
};

type QueuedAction = {
  info: ActionInfo;
  run: () => Promise<void>;
  reject(error: unknown): void;
};

type ToolDecision = Readonly<{ args: Record<string, unknown> }>;

type ToolExecutionState = {
  resultEntryIds: Map<string, string>;
  decisions: Map<string, ToolDecision>;
  getAssistantEntryId(): string | undefined;
  nextToolIndex(): number;
};

type RegistryHandler = (event: unknown) => unknown | Promise<unknown>;

type HookInvocationResult = Readonly<{ id: string; value: unknown }>;

class Registry {
  readonly #handlers = new Map<string, Map<string, RegistryHandler>>();
  readonly #idGenerator: () => string;

  constructor(idGenerator: () => string) {
    this.#idGenerator = idGenerator;
  }

  on(name: string, handler: RegistryHandler, options?: { id?: string }): () => void {
    if ((name === "before_run" || name === "before_resume") && options?.id === undefined) {
      throw new TypeError(`${name} requires a stable registration id for crash recovery`);
    }
    const id = options?.id ?? this.#idGenerator();
    const handlers = this.#handlers.get(name) ?? new Map<string, RegistryHandler>();
    if (handlers.has(id)) throw new Error(`A Harness handler already uses id ${id}`);
    handlers.set(id, handler);
    this.#handlers.set(name, handlers);
    return () => {
      handlers.delete(id);
      if (handlers.size === 0) this.#handlers.delete(name);
    };
  }

  async emit(name: string, event: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of this.#handlers.get(name)?.values() ?? []) {
      try {
        const candidate = await handler(event);
        if (candidate !== undefined) result = candidate;
      } catch {
        // Hooks are extensions, not orchestration authority. One defective
        // handler must not prevent later handlers or durable settlement.
      }
    }
    for (const handler of this.#handlers.get("*")?.values() ?? []) {
      try {
        await handler(event);
      } catch {
        // Passive observers never affect execution.
      }
    }
    return result;
  }

  async invoke(
    name: string,
    event: unknown | ((id: string) => unknown),
  ): Promise<HookInvocationResult[]> {
    const results: HookInvocationResult[] = [];
    for (const [id, handler] of this.#handlers.get(name)?.entries() ?? []) {
      try {
        const value = await handler(typeof event === "function" ? event(id) : event);
        results.push({ id, value });
      } catch {
        results.push({ id, value: undefined });
      }
    }
    const observed = typeof event === "function" ? event("*") : event;
    for (const handler of this.#handlers.get("*")?.values() ?? []) {
      try {
        await handler(observed);
      } catch {
        // Passive observers never affect execution.
      }
    }
    return results;
  }

  async fold<T>(
    name: string,
    initial: T,
    event: (current: T, id: string) => unknown,
    reduce: (current: T, value: unknown, id: string) => T | Promise<T>,
  ): Promise<T> {
    let current = initial;
    for (const [id, handler] of this.#handlers.get(name)?.entries() ?? []) {
      try {
        current = await reduce(current, await handler(event(current, id)), id);
      } catch {
        // A failed transforming hook contributes no patch.
      }
    }
    for (const handler of this.#handlers.get("*")?.values() ?? []) {
      try {
        await handler(event(current, "*"));
      } catch {
        // Passive observers never affect execution.
      }
    }
    return current;
  }

  async pipeline<T>(
    name: string,
    initial: T,
    event: (current: T, id: string) => unknown,
    reduce: (
      current: T,
      value: unknown,
      id: string,
    ) => { state: T; stop?: boolean } | Promise<{ state: T; stop?: boolean }>,
    onError: (current: T, error: unknown, id: string) => T | Promise<T>,
  ): Promise<T> {
    let current = initial;
    for (const [id, handler] of this.#handlers.get(name)?.entries() ?? []) {
      try {
        const reduced = await reduce(current, await handler(event(current, id)), id);
        current = reduced.state;
        if (reduced.stop === true) break;
      } catch (error: unknown) {
        current = await onError(current, error, id);
        break;
      }
    }
    for (const handler of this.#handlers.get("*")?.values() ?? []) {
      try {
        await handler(event(current, "*"));
      } catch {
        // Passive observers never affect execution.
      }
    }
    return current;
  }
}

function cloneResources(resources: Resources | undefined): Resources {
  return {
    ...(resources?.skills === undefined ? {} : { skills: [...resources.skills] }),
    ...(resources?.promptTemplates === undefined
      ? {}
      : { promptTemplates: [...resources.promptTemplates] }),
  };
}

function cloneStreamOptions(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
  return {
    ...(options ?? {}),
    ...(options?.headers === undefined ? {} : { headers: { ...options.headers } }),
    ...(options?.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
  };
}

function applyStreamOptionsPatch(
  base: SimpleStreamOptions,
  patch: Partial<SimpleStreamOptions> | undefined,
): SimpleStreamOptions {
  if (patch === undefined) return cloneStreamOptions(base);
  const result = cloneStreamOptions(base);
  for (const [key, value] of Object.entries(patch)) {
    if (key === "headers" || key === "metadata") continue;
    (result as Record<string, unknown>)[key] = value;
  }
  if (Object.hasOwn(patch, "headers")) {
    if (patch.headers === undefined) delete result.headers;
    else result.headers = { ...(result.headers ?? {}), ...patch.headers };
  }
  if (Object.hasOwn(patch, "metadata")) {
    if (patch.metadata === undefined) delete result.metadata;
    else result.metadata = { ...(result.metadata ?? {}), ...patch.metadata };
  }
  return result;
}

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...(images ?? [])],
    timestamp: Date.now(),
  };
}

function normalizeMessages(
  input: string | AgentMessage | AgentMessage[],
  images?: ImageContent[],
): AgentMessage[] | undefined {
  const messages =
    typeof input === "string"
      ? [createUserMessage(input, images)]
      : Array.isArray(input)
        ? input
        : [input];
  if (messages.length === 0) return undefined;
  if (
    messages.some(
      (message) => message === null || typeof message !== "object" || !("role" in message),
    )
  ) {
    return undefined;
  }
  return structuredClone(messages);
}

function operationError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: error.name || "execution_failed", message: error.message };
  }
  return { code: "execution_failed", message: String(error) };
}

function combinedSignal(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

function assistantOutcome(message: AssistantMessage): "completed" | "aborted" | "failed" {
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error") return "failed";
  return "completed";
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function findDuplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicate.add(name);
    seen.add(name);
  }
  return [...duplicate];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

/**
 * Pi messages use optional fields and some internal paths materialize those
 * fields as `undefined`. SessionStorage deliberately accepts JSON values only,
 * so remove undefined object properties at the Harness boundary while still
 * leaving genuinely invalid values (undefined array items, functions, bigint,
 * cycles) for the storage validator to reject.
 */
function normalizeDurableMessage(message: AgentMessage): AgentMessage {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isObject(value)) return value;
    const normalized: Record<string, unknown> = {};
    for (const [key, candidate] of Object.entries(value)) {
      if (candidate !== undefined) normalized[key] = visit(candidate);
    }
    return normalized;
  };
  return visit(message) as AgentMessage;
}

/**
 * AgentDock's executable implementation of Pi 0.84's public AgentHarness
 * contract. It deliberately composes Pi public primitives instead of forking
 * or patching Pi's scaffold.
 *
 * Durable authority is operation-scoped, Session entries/records are the
 * source of truth, Tools share the same opaque authority, and unsafe Tool
 * effects are never replayed during recovery.
 */
export class DurableAgentHarness implements AgentLane {
  readonly name = "main";
  readonly session: SessionTree;
  readonly hooks: {
    on: (name: HookName, handler: RegistryHandler, options?: { id?: string }) => () => void;
  };
  readonly events: { on: (type: string, listener: RegistryHandler) => () => void };

  readonly #options: DurableAgentHarnessOptions;
  readonly #durableSession: Session;
  readonly #id: () => string;
  readonly #hookRegistry: Registry;
  readonly #eventRegistry: Registry;
  readonly #active = new Map<string, ActiveOperation>();
  readonly #queuedMessageIds = new WeakMap<object, string>();
  readonly #actions: QueuedAction[] = [];
  readonly #actionWaiters = new Set<() => void>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #knownModels = new Map<string, Model<Api>>();
  #model: Model<Api>;
  #thinkingLevel: ThinkingLevel;
  #tools: HarnessTool[];
  #activeToolNames: string[];
  #resources: Resources;
  #streamOptions: SimpleStreamOptions;
  #retry: RetryPolicy;
  #compaction: CompactionSettings;
  #steeringMode: QueueMode;
  #followUpMode: QueueMode;
  #closed = false;
  #faulted = false;
  #pendingOperationStarts = 0;

  constructor(options: DurableAgentHarnessOptions) {
    if (options.models === undefined && options.streamFn === undefined) {
      throw new TypeError("DurableAgentHarness requires Pi Models or a streamFn adapter");
    }
    this.#options = options;
    this.#durableSession = options.session;
    this.session = options.session.view("main");
    this.#id = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#hookRegistry = new Registry(this.#id);
    this.#eventRegistry = new Registry(this.#id);
    this.hooks = {
      on: (name, handler, registryOptions) => {
        if (this.#closed) throw new HarnessClosed();
        return this.#hookRegistry.on(name, handler, registryOptions);
      },
    };
    this.events = {
      on: (type, listener) => {
        if (this.#closed) throw new HarnessClosed();
        return this.#eventRegistry.on(type, listener);
      },
    };
    this.#model = options.model;
    this.#knownModels.set(this.#modelKey(options.model.provider, options.model.id), options.model);
    this.#thinkingLevel = options.thinkingLevel ?? "off";
    this.#tools = [...(options.tools ?? [])];
    this.#activeToolNames = [...(options.activeToolNames ?? this.#tools.map((tool) => tool.name))];
    this.#resources = cloneResources(options.resources);
    this.#streamOptions = cloneStreamOptions(options.streamOptions);
    this.#retry = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1_000 };
    this.#compaction = { ...(options.compaction ?? DEFAULT_COMPACTION_SETTINGS) };
    this.#steeringMode = options.steeringMode ?? "one-at-a-time";
    this.#followUpMode = options.followUpMode ?? "one-at-a-time";
    this.#validateTools(this.#tools, this.#activeToolNames);
  }

  static async create(
    options: DurableAgentHarnessOptions,
  ): Promise<{ harness: DurableAgentHarness; suspended: SuspendedOperation[] }> {
    const harness = new DurableAgentHarness(options);
    const path = await options.session.view("main").findEntriesOnBranch({ order: "oldestFirst" });
    const restored = buildSessionContext(path);
    if (restored.model !== null) {
      const restoredModel =
        restored.model.provider === options.model.provider &&
        restored.model.modelId === options.model.id
          ? options.model
          : options.models?.getModel(restored.model.provider, restored.model.modelId);
      if (restoredModel !== undefined) {
        harness.#model = restoredModel;
        harness.#knownModels.set(
          harness.#modelKey(restoredModel.provider, restoredModel.id),
          restoredModel,
        );
      }
    }
    if (
      path.some((entry) => entry.type === "thinking_level_change") &&
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(restored.thinkingLevel)
    ) {
      harness.#thinkingLevel = restored.thinkingLevel as ThinkingLevel;
    }
    if (restored.activeToolNames !== null) {
      const known = new Set(harness.#tools.map((tool) => tool.name));
      harness.#activeToolNames = restored.activeToolNames.filter((name) => known.has(name));
    }
    return { harness, suspended: await harness.#suspendedOperations() };
  }

  async getLeafId(): Promise<string | null> {
    return this.#durableSession.getLeafId();
  }

  async prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
  async prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<RunResult> {
    return this.#lanePrompt("main", input, images);
  }

  async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
    const skill = this.#resources.skills?.find((candidate) => candidate.name === name);
    if (skill === undefined) {
      return err(new UnknownSkill({ name, message: `Unknown skill: ${name}` }));
    }
    return this.prompt(formatSkillInvocation(skill, additionalInstructions));
  }

  async promptFromTemplate(name: string, args: string[] = []): Promise<RunResult> {
    const template = this.#resources.promptTemplates?.find((candidate) => candidate.name === name);
    if (template === undefined) {
      return err(new UnknownTemplate({ name, message: `Unknown prompt template: ${name}` }));
    }
    return this.prompt(formatPromptTemplateInvocation(template, args));
  }

  async compact(options?: { customInstructions?: string }): Promise<CompactionResult> {
    return this.#laneCompact("main", options);
  }

  async navigateTree(
    targetId: string | null,
    options?: NavigateOptions,
  ): Promise<NavigationResult> {
    return this.#laneNavigate("main", targetId, options);
  }

  async resume(): Promise<ResumeResult> {
    return this.#laneResume("main");
  }

  async abort(): Promise<AbortResult> {
    return this.#laneAbort("main");
  }

  async steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
  async steer(message: AgentMessage): Promise<QueueResult>;
  async steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
    return this.#enqueue("main", "steer", input, images);
  }

  async followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
  async followUp(message: AgentMessage): Promise<QueueResult>;
  async followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
    return this.#enqueue("main", "followUp", input, images);
  }

  async nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
  async nextRun(message: AgentMessage): Promise<QueueResult>;
  async nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
    return this.#enqueue("main", "nextRun", input, images);
  }

  async cancelQueued(entryId: string): Promise<CancelQueuedResult> {
    return this.#laneCancelQueued("main", entryId);
  }

  async recordUsage(
    usage: Usage,
    options?: { entryId?: string; details?: import("@earendil-works/pi-agent-core").JsonValue },
  ): Promise<RecordUsageResult> {
    return this.#laneRecordUsage("main", usage, options);
  }

  async #laneRecordUsage(
    lane: string,
    usage: Usage,
    options?: { entryId?: string; details?: import("@earendil-works/pi-agent-core").JsonValue },
  ): Promise<RecordUsageResult> {
    if (this.#closed) return err(this.#closedError());
    await this.#durableSession.appendRecord({
      id: this.#id(),
      lane,
      type: "usage",
      cause: "adjustment",
      usage: structuredClone(usage),
      ...(options?.entryId === undefined ? {} : { entryId: options.entryId }),
      ...(options?.details === undefined ? {} : { details: structuredClone(options.details) }),
    });
    await this.#emitEvent("usage", { type: "usage", lane, usage });
    return ok(undefined);
  }

  async waitForIdle(): Promise<void> {
    while (this.#pendingOperationStarts > 0 || this.#active.size > 0) {
      await new Promise<void>((resolvePromise) => this.#idleWaiters.add(resolvePromise));
    }
  }

  async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
    await this.waitForIdle();
    if (this.#closed) return;
    await callback();
  }

  async peekAction(): Promise<ActionInfo | undefined> {
    return this.#actions[0]?.info;
  }

  async executeAction(): Promise<ActionInfo | undefined> {
    const action = this.#actions.shift();
    if (action === undefined) return undefined;
    await action.run();
    return action.info;
  }

  async runToCompletion(): Promise<void> {
    while (this.#pendingOperationStarts > 0 || this.#active.size > 0 || this.#actions.length > 0) {
      const action = await this.executeAction();
      if (action !== undefined) continue;
      await Promise.race([
        this.#waitForActionOrIdle(),
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1)),
      ]);
    }
  }

  async getModel(): Promise<Model<Api>> {
    return this.#laneModel("main");
  }

  async setModel(model: Model<Api>): Promise<void> {
    await this.#setLaneModel("main", model);
  }

  async getThinkingLevel(): Promise<ThinkingLevel> {
    return this.#laneThinkingLevel("main");
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.#setLaneThinkingLevel("main", level);
  }

  async getActiveTools(): Promise<string[]> {
    return this.#laneActiveTools("main");
  }

  async setActiveTools(names: string[]): Promise<void> {
    await this.#setLaneActiveTools("main", names);
  }

  async watch(): Promise<WatchHandle<LaneSnapshot>> {
    return this.#watchLane("main");
  }

  async lane(name: string): Promise<AgentLane | undefined> {
    const exists = (await this.#durableSession.getLanes()).some((lane) => lane.lane === name);
    return exists ? new DurableAgentLane(this, name) : undefined;
  }

  async createLane(name: string, at: string | null): Promise<CreateLaneResult> {
    if (this.#closed) return err(this.#closedError());
    if (name.trim().length === 0 || name === "main" || /[\u0000-\u001f\u007f]/.test(name)) {
      return err(
        new InvalidLane({ lane: name, reason: "invalid_name", message: "Lane name is invalid" }),
      );
    }
    if ((await this.#durableSession.getLanes()).some((lane) => lane.lane === name)) {
      return err(new LaneExists({ lane: name, message: `Lane already exists: ${name}` }));
    }
    if (at !== null && (await this.#durableSession.getEntry(at)) === undefined) {
      return err(new UnknownTarget({ targetId: at, message: `Unknown Session entry: ${at}` }));
    }
    await this.#durableSession.createLane(name, at);
    await this.#emitEvent("lane_created", { type: "lane_created", lane: name, at });
    return ok(new DurableAgentLane(this, name));
  }

  async lanes(): Promise<LaneInfo[]> {
    const lanes = await this.#durableSession.getLanes();
    return Promise.all(lanes.map((lane) => this.#laneInfo(lane.lane, lane.leafId)));
  }

  async getTools(): Promise<HarnessTool[]> {
    return [...this.#tools];
  }

  async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
    this.#assertMutableConfig();
    const names = activeNames ?? tools.map((tool) => tool.name);
    this.#validateTools(tools, names);
    this.#tools = [...tools];
    this.#activeToolNames = [...names];
  }

  async getResources(): Promise<Resources> {
    return cloneResources(this.#resources);
  }

  async setResources(resources: Resources): Promise<void> {
    this.#assertMutableConfig();
    this.#resources = cloneResources(resources);
  }

  async getStreamOptions(): Promise<SimpleStreamOptions> {
    return cloneStreamOptions(this.#streamOptions);
  }

  async setStreamOptions(options: SimpleStreamOptions): Promise<void> {
    this.#assertMutableConfig();
    this.#streamOptions = cloneStreamOptions(options);
  }

  async getRetryPolicy(): Promise<RetryPolicy> {
    return { ...this.#retry };
  }

  async setRetryPolicy(policy: RetryPolicy): Promise<void> {
    this.#assertMutableConfig();
    this.#retry = { ...policy };
  }

  async getCompactionSettings(): Promise<CompactionSettings> {
    return { ...this.#compaction };
  }

  async setCompactionSettings(settings: CompactionSettings): Promise<void> {
    this.#assertMutableConfig();
    this.#compaction = { ...settings };
  }

  async getSteeringMode(): Promise<QueueMode> {
    return this.#steeringMode;
  }

  async setSteeringMode(mode: QueueMode): Promise<void> {
    this.#assertMutableConfig();
    this.#steeringMode = mode;
  }

  async getFollowUpMode(): Promise<QueueMode> {
    return this.#followUpMode;
  }

  async setFollowUpMode(mode: QueueMode): Promise<void> {
    this.#assertMutableConfig();
    this.#followUpMode = mode;
  }

  async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
    const handle = new MutableWatchHandle(await this.#sessionSnapshot(), () => undefined);
    const unsubscribe = this.#eventRegistry.on("*", async () => {
      handle.update(await this.#sessionSnapshot());
    });
    handle.setUnsubscribe(unsubscribe);
    return handle;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const active of this.#active.values()) active.agent?.abort();
    const closeError = new HarnessClosed();
    for (const action of this.#actions.splice(0)) action.reject(closeError);
    this.#notifyActionWaiters();
    this.#notifyIdleWaiters();
    await this.waitForIdle();
    for (const waiter of this.#actionWaiters) waiter();
    this.#actionWaiters.clear();
  }

  async #resolveSystemPrompt(): Promise<string> {
    return typeof this.#options.systemPrompt === "string"
      ? this.#options.systemPrompt
      : this.#options.systemPrompt();
  }

  async #runBeforeRunHook(
    lane: string,
    runId: string,
    prompt: AgentMessage[],
    systemPrompt: string,
    authority: DurableAgentExecutionAuthority,
  ): Promise<{
    messages: AgentMessage[];
    systemPromptOverride?: string;
    resumeData: Record<string, JsonValue>;
  }> {
    const invocations = await this.#performAction(
      { kind: "hook", name: "before_run" },
      async () => {
        await authority.assertCurrent();
        return this.#hookRegistry.invoke("before_run", {
          lane,
          runId,
          prompt: structuredClone(prompt),
          systemPrompt,
          resources: cloneResources(this.#resources),
        });
      },
    );
    const messages: AgentMessage[] = [];
    const resumeData: Record<string, JsonValue> = {};
    let systemPromptOverride: string | undefined;
    for (const invocation of invocations) {
      if (!isObject(invocation.value)) continue;
      if (Array.isArray(invocation.value.messages)) {
        const normalized = normalizeMessages(invocation.value.messages as AgentMessage[]);
        if (normalized !== undefined) messages.push(...normalized);
      }
      if (typeof invocation.value.systemPrompt === "string") {
        systemPromptOverride = invocation.value.systemPrompt;
      }
      if (isJsonValue(invocation.value.resumeData)) {
        resumeData[invocation.id] = structuredClone(invocation.value.resumeData);
      }
    }
    return {
      messages,
      resumeData,
      ...(systemPromptOverride === undefined ? {} : { systemPromptOverride }),
    };
  }

  async #runBeforeResumeHook(
    lane: string,
    runId: string,
    context: DurableRunContext,
    authority: DurableAgentExecutionAuthority,
  ): Promise<void> {
    await this.#performAction({ kind: "hook", name: "before_resume" }, async () => {
      await authority.assertCurrent();
      await this.#hookRegistry.invoke("before_resume", (registrationId: string) => ({
        lane,
        runId,
        kind: "run",
        prompt: structuredClone(context.originalPrompt),
        ...(context.systemPromptOverride === undefined
          ? {}
          : { systemPromptOverride: context.systemPromptOverride }),
        ...(context.resumeData?.[registrationId] === undefined
          ? {}
          : { resumeData: structuredClone(context.resumeData[registrationId]) }),
      }));
    });
  }

  async #lanePrompt(
    lane: string,
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<RunResult> {
    if (this.#closed) return err(this.#closedError());
    const prompt = normalizeMessages(input, images);
    if (prompt === undefined) {
      return err(
        new InvalidMessage({
          lane,
          reason: "invalid_or_empty",
          message: "Prompt must contain a message",
        }),
      );
    }
    this.#pendingOperationStarts += 1;
    let authority: DurableAgentExecutionAuthority | undefined;
    let authorityTransferred = false;
    try {
      const busy = await this.#busy(lane);
      if (busy !== undefined) return err(busy);

      const nextRun = await this.#pendingQueue(lane, "nextRun");
      const operationId = this.#id();
      authority = await this.#options.authorityProvider.acquire(this.#options.scope);
      await authority.assertCurrent();
      const baseSystemPrompt = await this.#resolveSystemPrompt();
      const beforeRun = await this.#runBeforeRunHook(
        lane,
        operationId,
        prompt,
        baseSystemPrompt,
        authority,
      );
      const initialMessages = [
        ...nextRun.map((item) => item.message),
        ...prompt,
        ...beforeRun.messages,
      ];
      const initialEntries = initialMessages.map((message) => ({
        id: this.#queuedMessageIds.get(message as object) ?? this.#id(),
        type: "message" as const,
        message,
      }));
      const sourceLeafId = await this.#durableSession.view(lane).getLeafId();
      await this.#performAction(
        { kind: "append_record", recordType: "operation_started" },
        async () => {
          await this.#durableSession.appendRecord({
            id: operationId,
            lane,
            type: "operation_started",
            sourceLeafId,
            intent: {
              kind: "run",
              originalPrompt: prompt,
              initialMessages: initialEntries,
              ...(beforeRun.systemPromptOverride === undefined
                ? {}
                : { systemPromptOverride: beforeRun.systemPromptOverride }),
              ...(Object.keys(beforeRun.resumeData).length === 0
                ? {}
                : { resumeData: beforeRun.resumeData }),
            },
          });
        },
      );
      const execution = this.#executeRun(lane, operationId, initialEntries, authority, {
        originalPrompt: prompt,
        ...(beforeRun.systemPromptOverride === undefined
          ? {}
          : { systemPromptOverride: beforeRun.systemPromptOverride }),
        ...(Object.keys(beforeRun.resumeData).length === 0
          ? {}
          : { resumeData: beforeRun.resumeData }),
      });
      const tracked = this.#trackOperation(lane, operationId, "run", authority, execution);
      authorityTransferred = true;
      return tracked;
    } finally {
      if (authority !== undefined && !authorityTransferred) await authority.close();
      this.#pendingOperationStarts -= 1;
      this.#notifyActionWaiters();
      this.#notifyIdleWaiters();
    }
  }

  async #executeRun(
    lane: string,
    operationId: string,
    initialEntries: ProvisionedEntry[],
    authority: DurableAgentExecutionAuthority,
    runContext: DurableRunContext,
  ): Promise<RunResult> {
    let finalEntryId: string | undefined;
    let finalMessage: AssistantMessage | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      await authority.assertCurrent();

      for (const entry of initialEntries) {
        if ((await this.#durableSession.getEntry(entry.id)) === undefined) {
          await this.#performAction(
            { kind: "append_entry", entryType: entry.type, entryId: entry.id },
            async () => {
              await authority.assertCurrent();
              await this.#durableSession.appendEntry(entry, lane);
            },
          );
        }
        await this.#consumeQueueEntry(lane, operationId, entry.id);
      }

      const path = (
        await this.#durableSession
          .view(lane)
          .findEntriesOnBranch({ stopAtType: "compaction", order: "newestFirst" })
      ).reverse();
      const restored = await this.#buildContext(path);
      const systemPrompt = runContext.systemPromptOverride ?? (await this.#resolveSystemPrompt());
      const runModel = await this.#laneModel(lane);
      const runThinkingLevel = await this.#laneThinkingLevel(lane);
      const runActiveToolNames = await this.#laneActiveTools(lane);
      const resultEntryIds = new Map<string, string>();
      const toolDecisions = new Map<string, ToolDecision>();
      let lastAssistantEntryId: string | undefined;
      let toolIndex = 0;
      const toolExecutionState: ToolExecutionState = {
        resultEntryIds,
        decisions: toolDecisions,
        getAssistantEntryId: () => lastAssistantEntryId,
        nextToolIndex: () => toolIndex++,
      };
      const activeTools = this.#tools
        .filter((tool) => runActiveToolNames.includes(tool.name))
        .map((tool) => this.#bindTool(tool, authority, lane, operationId, toolExecutionState));
      let responseMetadata: { status?: number; headers?: Record<string, string> } = {};
      const streamFn: StreamFn = async (model, context, streamOptions) => {
        const attempt =
          (
            await this.#durableSession.findRecords({
              lane,
              type: "step_attempt",
              runId: operationId,
            })
          ).filter((record) => record.step === "assistant").length + 1;
        const resultId = this.#id();
        await this.#performAction(
          { kind: "append_record", recordType: "step_attempt" },
          async () => {
            await this.#durableSession.appendRecord({
              id: this.#id(),
              lane,
              type: "step_attempt",
              runId: operationId,
              step: "assistant",
              attempt,
              resultEntryId: resultId,
            });
          },
        );
        const hookOptions = await this.#hookRegistry.fold<SimpleStreamOptions>(
          "before_request",
          {},
          (current) => ({
            lane,
            runId: operationId,
            model,
            context,
            streamOptions: applyStreamOptionsPatch(streamOptions ?? {}, current),
          }),
          (current, value) =>
            isObject(value) && isObject(value.streamOptions)
              ? applyStreamOptionsPatch(
                  current,
                  value.streamOptions as Partial<SimpleStreamOptions>,
                )
              : current,
        );
        const payloadCallbacks = [
          this.#streamOptions.onPayload,
          streamOptions?.onPayload,
          hookOptions.onPayload,
        ].filter((callback) => callback !== undefined);
        const responseCallbacks = [
          this.#streamOptions.onResponse,
          streamOptions?.onResponse,
          hookOptions.onResponse,
        ].filter((callback) => callback !== undefined);
        const effectiveOptions: SimpleStreamOptions = {
          ...this.#streamOptions,
          ...streamOptions,
          ...hookOptions,
          headers: {
            ...this.#streamOptions.headers,
            ...streamOptions?.headers,
            ...hookOptions.headers,
          },
          metadata: {
            ...this.#streamOptions.metadata,
            ...streamOptions?.metadata,
            ...hookOptions.metadata,
          },
          onPayload: async (payload, payloadModel) => {
            let currentPayload = await this.#hookRegistry.fold<unknown>(
              "before_payload",
              payload,
              (current) => ({
                lane,
                runId: operationId,
                model: payloadModel,
                payload: current,
              }),
              (current, value) => (isObject(value) && "payload" in value ? value.payload : current),
            );
            for (const callback of payloadCallbacks) {
              currentPayload = (await callback(currentPayload, payloadModel)) ?? currentPayload;
            }
            return currentPayload;
          },
          onResponse: async (response, responseModel) => {
            for (const callback of responseCallbacks) await callback(response, responseModel);
            responseMetadata = {
              status: response.status,
              headers: { ...(response.headers as Record<string, string>) },
            };
          },
        };
        return this.#performAction(
          { kind: "stream_assistant", step: "assistant", attempt },
          async () =>
            this.#options.streamFn?.(model, context, effectiveOptions) ??
            this.#models().streamSimple(model, context, effectiveOptions),
        );
      };
      const transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
        let transformed = this.#options.transformContext
          ? await this.#options.transformContext(messages, signal)
          : messages;
        return this.#hookRegistry.fold<AgentMessage[]>(
          "transform_context",
          transformed,
          (current) => ({ lane, runId: operationId, messages: current, signal }),
          (current, value) =>
            isObject(value) && Array.isArray(value.messages)
              ? (value.messages as AgentMessage[])
              : current,
        );
      };
      const agent = new Agent({
        streamFn,
        initialState: {
          systemPrompt,
          model: runModel,
          thinkingLevel: runThinkingLevel,
          messages: restored.messages,
          tools: activeTools,
        },
        convertToLlm: this.#options.toProviderMessages ?? convertToLlm,
        transformContext,
        toolExecution: this.#options.toolExecution ?? "sequential",
        steeringMode: this.#steeringMode,
        followUpMode: this.#followUpMode,
        beforeToolCall: async (context, signal) => {
          await authority.assertCurrent();
          const tool = this.#tools.find((candidate) => candidate.name === context.toolCall.name);
          const decision = await this.#performAction(
            { kind: "hook", name: "before_tool" },
            async () =>
              this.#runBeforeToolHooks({
                lane,
                runId: operationId,
                toolCallId: context.toolCall.id,
                toolName: context.toolCall.name,
                tool,
                args: isObject(context.args) ? context.args : {},
                signal,
              }),
          );
          if (decision.blocked !== undefined) {
            toolDecisions.delete(context.toolCall.id);
            return {
              block: true,
              reason: decision.blocked.reason,
              ...(decision.blocked.terminate === undefined
                ? {}
                : { terminate: decision.blocked.terminate }),
            };
          }
          toolDecisions.set(context.toolCall.id, { args: structuredClone(decision.args) });
          return undefined;
        },
        afterToolCall: async (context, signal) => {
          await authority.assertCurrent();
          const patched = await this.#performAction(
            { kind: "hook", name: "after_tool" },
            async () =>
              this.#runAfterToolHooks({
                lane,
                runId: operationId,
                toolCallId: context.toolCall.id,
                toolName: context.toolCall.name,
                args: structuredClone(
                  toolDecisions.get(context.toolCall.id)?.args ??
                    (isObject(context.args) ? context.args : {}),
                ),
                result: context.result,
                isError: context.isError,
                signal,
              }),
          );
          toolDecisions.delete(context.toolCall.id);
          return patched.changed ? { ...patched.result, isError: patched.isError } : undefined;
        },
      });
      const active = this.#active.get(lane);
      if (active !== undefined) active.agent = agent;
      const abortForAuthority = () => agent.abort();
      authority.signal.addEventListener("abort", abortForAuthority, { once: true });
      removeAbort = () => authority.signal.removeEventListener("abort", abortForAuthority);
      if (authority.signal.aborted) abortForAuthority();

      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end") {
          await authority.assertCurrent();
          let message = event.message;
          if (isAssistant(message)) {
            message = await this.#performAction(
              { kind: "hook", name: "after_response" },
              async () =>
                this.#hookRegistry.fold<AssistantMessage>(
                  "after_response",
                  message as AssistantMessage,
                  (current) => ({
                    lane,
                    runId: operationId,
                    ...responseMetadata,
                    message: current,
                  }),
                  (current, value) => {
                    if (!isObject(value) || !isObject(value.message)) return current;
                    const replacement = value.message as unknown as AgentMessage;
                    return isAssistant(replacement) ? replacement : current;
                  },
                ),
            );
            responseMetadata = {};
            if (message !== event.message) {
              const messages = agent.state.messages;
              if (messages.at(-1) === event.message) {
                agent.state.messages = [...messages.slice(0, -1), message];
              }
            }
          }
          const messageBeforeNormalization = message;
          message = normalizeDurableMessage(messageBeforeNormalization);
          const currentLastMessage = agent.state.messages.at(-1);
          if (
            currentLastMessage === event.message ||
            currentLastMessage === messageBeforeNormalization
          ) {
            agent.state.messages = [...agent.state.messages.slice(0, -1), message];
          }
          const toolCallId =
            message.role === "toolResult" && typeof message.toolCallId === "string"
              ? message.toolCallId
              : undefined;
          const queuedId = this.#queuedMessageIds.get(message as object);
          const entryId =
            queuedId ??
            (toolCallId === undefined ? undefined : resultEntryIds.get(toolCallId)) ??
            this.#id();
          let appended = false;
          if ((await this.#durableSession.getEntry(entryId)) === undefined) {
            await this.#performAction(
              { kind: "append_entry", entryType: "message", entryId },
              async () => {
                await this.#durableSession.appendEntry(
                  { id: entryId, type: "message", message },
                  lane,
                );
              },
            );
            appended = true;
          }
          await this.#consumeQueueEntry(lane, operationId, entryId);
          if (isAssistant(message)) {
            lastAssistantEntryId = entryId;
            finalEntryId = entryId;
            finalMessage = message;
            toolIndex = 0;
            if (appended) {
              await this.#recordAssistantUsage(lane, operationId, entryId, message);
            }
          } else if (appended && message.role === "toolResult" && message.usage !== undefined) {
            await this.#durableSession.appendRecord({
              id: this.#id(),
              lane,
              type: "usage",
              cause: "tool",
              runId: operationId,
              entryId,
              toolCallId: message.toolCallId,
              usage: message.usage,
            });
          }
        }
        const observedEvent =
          event.type === "message_end" &&
          finalMessage !== undefined &&
          event.message.role === "assistant"
            ? { ...event, message: finalMessage }
            : event;
        await this.#options.onEvent?.(observedEvent);
        await this.#emitEvent(event.type, observedEvent);
      });
      try {
        await agent.continue();
        if (
          finalMessage !== undefined &&
          !(finalMessage.stopReason === "deferred" && finalMessage.deferred !== undefined)
        ) {
          const hookResults = await this.#performAction(
            { kind: "hook", name: "before_run_end" },
            async () =>
              this.#hookRegistry.invoke("before_run_end", {
                lane,
                runId: operationId,
                messages: structuredClone(agent.state.messages),
              }),
          );
          const followUp = hookResults
            .map(({ value }) => (isObject(value) ? value.followUp : undefined))
            .reverse()
            .find((value): value is string => typeof value === "string" && value.length > 0);
          if (followUp !== undefined) {
            const queued = await this.#enqueue(lane, "followUp", followUp);
            if (!queued.ok) throw queued.error;
            await agent.continue();
          }
        }
      } finally {
        unsubscribe();
      }
      await authority.assertCurrent();
      if (finalMessage === undefined || finalEntryId === undefined) {
        throw new Error("Pi Agent Loop settled without a durable assistant message");
      }
      const outcome = assistantOutcome(finalMessage);
      if (finalMessage.stopReason === "deferred" && finalMessage.deferred !== undefined) {
        return ok({
          runId: operationId,
          kind: "suspended",
          leafId: await this.#requireLeaf(lane),
          finalEntryId,
          deferred: finalMessage.deferred,
        });
      }
      await this.#finishOperation(lane, operationId, outcome);
      await this.#maybeCompact(lane, authority);
      const leafId = await this.#requireLeaf(lane);
      if (outcome === "completed") {
        return ok({ runId: operationId, kind: "completed", leafId, finalEntryId, finalMessage });
      }
      if (outcome === "aborted") {
        return ok({ runId: operationId, kind: "aborted", leafId, finalEntryId, finalMessage });
      }
      return ok({
        runId: operationId,
        kind: "failed",
        leafId,
        finalEntryId,
        finalMessage,
        error: {
          code: "model_error",
          message: finalMessage.errorMessage ?? "Model request failed",
        },
      });
    } catch (error: unknown) {
      this.#faulted = true;
      const failure = operationError(error);
      await this.#finishOperation(
        lane,
        operationId,
        authority.signal.aborted ? "aborted" : "failed",
        failure,
      ).catch(() => undefined);
      const leafId = (await this.#durableSession.view(lane).getLeafId()) ?? "";
      return ok({
        runId: operationId,
        kind: authority.signal.aborted ? "aborted" : "failed",
        leafId,
        ...(finalEntryId === undefined ? {} : { finalEntryId }),
        ...(finalMessage === undefined ? {} : { finalMessage }),
        ...(authority.signal.aborted ? {} : { error: failure }),
      } as RunResult extends { ok: true; value: infer TValue } ? TValue : never);
    } finally {
      removeAbort?.();
      await authority.close();
    }
  }

  async #laneCompact(
    lane: string,
    options?: { customInstructions?: string },
  ): Promise<CompactionResult> {
    if (this.#closed) return err(this.#closedError());
    this.#pendingOperationStarts += 1;
    let authority: DurableAgentExecutionAuthority | undefined;
    let authorityTransferred = false;
    try {
      const busy = await this.#busy(lane);
      if (busy !== undefined) return err(busy);
      const entries = await this.#durableSession
        .view(lane)
        .findEntriesOnBranch({ order: "oldestFirst" });
      const preparation = prepareCompaction(entries, this.#compaction);
      if (!preparation.ok) {
        const runId = this.#id();
        const leafId = await this.#requireLeaf(lane);
        if (preparation.error.code === "aborted") {
          return ok({ runId, kind: "aborted", leafId });
        }
        return ok({ runId, kind: "failed", leafId, error: operationError(preparation.error) });
      }
      if (preparation.value === undefined) {
        return err(
          new NothingToCompact({ lane, message: "The active branch has nothing to compact" }),
        );
      }
      const operationId = this.#id();
      const resultEntryId = this.#id();
      authority = await this.#options.authorityProvider.acquire(this.#options.scope);
      await authority.assertCurrent();
      await this.#performAction(
        { kind: "append_record", recordType: "operation_started" },
        async () => {
          await this.#durableSession.appendRecord({
            id: operationId,
            lane,
            type: "operation_started",
            sourceLeafId: await this.#durableSession.view(lane).getLeafId(),
            intent: {
              kind: "compaction",
              resultEntryId,
              ...(options?.customInstructions === undefined
                ? {}
                : { customInstructions: options.customInstructions }),
            },
          });
        },
      );
      const execution = this.#executeCompaction(
        lane,
        operationId,
        resultEntryId,
        preparation.value,
        authority,
        options?.customInstructions,
        "manual",
      );
      const tracked = this.#trackOperation(lane, operationId, "compaction", authority, execution);
      authorityTransferred = true;
      return tracked;
    } finally {
      if (authority !== undefined && !authorityTransferred) await authority.close();
      this.#pendingOperationStarts -= 1;
      this.#notifyActionWaiters();
      this.#notifyIdleWaiters();
    }
  }

  async #executeCompaction(
    lane: string,
    operationId: string,
    resultEntryId: string,
    preparation: CompactionPreparation,
    authority: DurableAgentExecutionAuthority,
    customInstructions: string | undefined,
    reason: "manual" | "threshold" | "overflow",
    closeAuthority = true,
  ): Promise<CompactionResult> {
    try {
      await authority.assertCurrent();
      const hookResults = await this.#hookRegistry.invoke("before_compaction", {
        lane,
        runId: operationId,
        reason,
        preparation,
        customInstructions,
      });
      const hook = hookResults
        .map(({ value }) => value)
        .find((value) => isObject(value) && (value.decline === true || isObject(value.compaction)));
      if (isObject(hook) && hook.decline === true) {
        await this.#finishOperation(lane, operationId, "declined");
        return ok({ runId: operationId, kind: "declined", leafId: await this.#requireLeaf(lane) });
      }
      const attempts = await this.#durableSession.findRecords({
        lane,
        type: "step_attempt",
        runId: operationId,
      });
      const attempt = attempts.length + 1;
      await this.#durableSession.appendRecord({
        id: this.#id(),
        lane,
        type: "step_attempt",
        runId: operationId,
        step: "compaction",
        attempt,
        resultEntryId,
        compactionReason: reason,
      });
      const supplied = isObject(hook) && isObject(hook.compaction) ? hook.compaction : undefined;
      const compactionModel = await this.#laneModel(lane);
      const compactionThinkingLevel = await this.#laneThinkingLevel(lane);
      const result =
        supplied === undefined
          ? await this.#performAction(
              { kind: "stream_assistant", step: "compaction", attempt },
              async () =>
                compactSession(
                  preparation,
                  this.#models(),
                  compactionModel,
                  customInstructions,
                  authority.signal,
                  compactionThinkingLevel,
                  this.#retry,
                ),
            )
          : ok({
              summary: String(supplied.summary ?? ""),
              retainedTail: Array.isArray(supplied.retainedTail)
                ? (supplied.retainedTail as AgentMessage[])
                : preparation.retainedTail,
              tokensBefore:
                typeof supplied.tokensBefore === "number"
                  ? supplied.tokensBefore
                  : preparation.tokensBefore,
              ...(Object.hasOwn(supplied, "details") ? { details: supplied.details } : {}),
              ...(isObject(supplied.usage) ? { usage: supplied.usage as unknown as Usage } : {}),
            });
      if (!result.ok) {
        const leafId = await this.#requireLeaf(lane);
        if (isObject(result.error) && result.error.code === "aborted") {
          await this.#finishOperation(lane, operationId, "aborted", operationError(result.error));
          return ok({ runId: operationId, kind: "aborted", leafId });
        }
        const failure = operationError(result.error);
        await this.#finishOperation(lane, operationId, "failed", failure);
        return ok({ runId: operationId, kind: "failed", leafId, error: failure });
      }
      const entry: CompactionEntry = await this.#durableSession.appendEntry(
        {
          id: resultEntryId,
          type: "compaction",
          summary: result.value.summary,
          retainedTail: result.value.retainedTail,
          tokensBefore: result.value.tokensBefore,
          ...(result.value.details === undefined ? {} : { details: result.value.details }),
          ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
        },
        lane,
      );
      if (result.value.usage !== undefined) {
        await this.#durableSession.appendRecord({
          id: this.#id(),
          lane,
          type: "usage",
          cause: "compaction",
          runId: operationId,
          entryId: resultEntryId,
          attempt,
          stopReason: "stop",
          usage: result.value.usage,
        });
      }
      await this.#finishOperation(lane, operationId, "completed");
      return ok({ runId: operationId, kind: "completed", leafId: entry.id, entry });
    } catch (error: unknown) {
      const failure = operationError(error);
      await this.#finishOperation(lane, operationId, "failed", failure).catch(() => undefined);
      return ok({
        runId: operationId,
        kind: "failed",
        leafId: await this.#requireLeaf(lane),
        error: failure,
      });
    } finally {
      if (closeAuthority) await authority.close();
    }
  }

  async #laneNavigate(
    lane: string,
    targetId: string | null,
    options?: NavigateOptions,
  ): Promise<NavigationResult> {
    if (this.#closed) return err(this.#closedError());
    this.#pendingOperationStarts += 1;
    let authority: DurableAgentExecutionAuthority | undefined;
    let authorityTransferred = false;
    try {
      const busy = await this.#busy(lane);
      if (busy !== undefined) return err(busy);
      if (targetId !== null && (await this.#durableSession.getEntry(targetId)) === undefined) {
        return err(new UnknownTarget({ targetId, message: `Unknown Session entry: ${targetId}` }));
      }
      const operationId = this.#id();
      const summaryEntryId = options?.summarize ? this.#id() : undefined;
      authority = await this.#options.authorityProvider.acquire(this.#options.scope);
      await authority.assertCurrent();
      await this.#performAction(
        { kind: "append_record", recordType: "operation_started" },
        async () => {
          await this.#durableSession.appendRecord({
            id: operationId,
            lane,
            type: "operation_started",
            sourceLeafId: await this.#durableSession.view(lane).getLeafId(),
            intent: {
              kind: "navigation",
              targetId,
              summarize: options?.summarize ?? false,
              ...(options?.customInstructions === undefined
                ? {}
                : { customInstructions: options.customInstructions }),
              ...(options?.label === undefined ? {} : { label: options.label }),
              ...(summaryEntryId === undefined ? {} : { summaryEntryId }),
            },
          });
        },
      );
      const execution = this.#executeNavigation(
        lane,
        operationId,
        targetId,
        options,
        summaryEntryId,
        authority,
      );
      const tracked = this.#trackOperation(lane, operationId, "navigation", authority, execution);
      authorityTransferred = true;
      return tracked;
    } finally {
      if (authority !== undefined && !authorityTransferred) await authority.close();
      this.#pendingOperationStarts -= 1;
      this.#notifyActionWaiters();
      this.#notifyIdleWaiters();
    }
  }

  async #executeNavigation(
    lane: string,
    operationId: string,
    targetId: string | null,
    options: NavigateOptions | undefined,
    summaryEntryId: string | undefined,
    authority: DurableAgentExecutionAuthority,
  ): Promise<NavigationResult> {
    const oldLeafId = await this.#durableSession.view(lane).getLeafId();
    try {
      await authority.assertCurrent();
      const collected =
        options?.summarize && oldLeafId !== null && targetId !== null
          ? await collectEntriesForBranchSummary(this.#durableSession, oldLeafId, targetId)
          : undefined;
      const hookResults = options?.summarize
        ? await this.#hookRegistry.invoke("before_navigation", {
            lane,
            runId: operationId,
            oldLeafId,
            targetId,
            preparation: collected,
            customInstructions: options.customInstructions,
          })
        : [];
      const hook = hookResults
        .map(({ value }) => value)
        .find((value) => isObject(value) && (value.decline === true || isObject(value.summary)));
      if (isObject(hook) && hook.decline === true) {
        await this.#finishOperation(lane, operationId, "declined");
        return ok({ runId: operationId, kind: "declined", leafId: oldLeafId });
      }
      let summaryEntry: import("@earendil-works/pi-agent-core").BranchSummaryEntry | undefined;
      if (
        options?.summarize &&
        oldLeafId !== null &&
        targetId !== null &&
        summaryEntryId !== undefined
      ) {
        if (collected !== undefined && collected.entries.length > 0) {
          const attempts = await this.#durableSession.findRecords({
            lane,
            type: "step_attempt",
            runId: operationId,
          });
          const attempt = attempts.length + 1;
          await this.#durableSession.appendRecord({
            id: this.#id(),
            lane,
            type: "step_attempt",
            runId: operationId,
            step: "branch_summary",
            attempt,
            resultEntryId: summaryEntryId,
          });
          const supplied = isObject(hook) && isObject(hook.summary) ? hook.summary : undefined;
          const summary =
            supplied === undefined
              ? await this.#performAction(
                  { kind: "stream_assistant", step: "branch_summary", attempt },
                  async () =>
                    generateBranchSummary(collected.entries, {
                      models: this.#models(),
                      model: await this.#laneModel(lane),
                      signal: authority.signal,
                      retry: this.#retry,
                      ...(options.customInstructions === undefined
                        ? {}
                        : { customInstructions: options.customInstructions }),
                    }),
                )
              : ok({
                  summary: String(supplied.summary ?? ""),
                  readFiles: Array.isArray(supplied.readFiles)
                    ? supplied.readFiles.filter(
                        (value): value is string => typeof value === "string",
                      )
                    : [],
                  modifiedFiles: Array.isArray(supplied.modifiedFiles)
                    ? supplied.modifiedFiles.filter(
                        (value): value is string => typeof value === "string",
                      )
                    : [],
                  ...(isObject(supplied.usage)
                    ? { usage: supplied.usage as unknown as Usage }
                    : {}),
                  ...(Object.hasOwn(supplied, "details")
                    ? { suppliedDetails: supplied.details }
                    : {}),
                });
          if (!summary.ok) throw summary.error;
          await this.#performAction({ kind: "move_lane", to: targetId }, async () => {
            await this.#durableSession.moveLane(lane, targetId);
          });
          summaryEntry = (await this.#durableSession.appendEntry(
            {
              id: summaryEntryId,
              type: "branch_summary",
              fromId: oldLeafId,
              summary: summary.value.summary,
              details: {
                readFiles: summary.value.readFiles,
                modifiedFiles: summary.value.modifiedFiles,
                ...(Object.hasOwn(summary.value, "suppliedDetails")
                  ? {
                      hook: (
                        summary.value as typeof summary.value & {
                          suppliedDetails?: unknown;
                        }
                      ).suppliedDetails,
                    }
                  : {}),
              },
              ...(summary.value.usage === undefined ? {} : { usage: summary.value.usage }),
            },
            lane,
          )) as BranchSummaryEntry;
          if (summary.value.usage !== undefined) {
            await this.#durableSession.appendRecord({
              id: this.#id(),
              lane,
              type: "usage",
              cause: "branch_summary",
              runId: operationId,
              entryId: summaryEntryId,
              attempt,
              stopReason: "stop",
              usage: summary.value.usage,
            });
          }
        }
      }
      if (summaryEntry === undefined) {
        await this.#performAction({ kind: "move_lane", to: targetId }, async () => {
          await this.#durableSession.moveLane(lane, targetId);
        });
      }
      if (options?.label !== undefined && targetId !== null) {
        await this.#performAction({ kind: "set_fact", fact: "label" }, async () => {
          await this.#durableSession.setLabel(targetId, options.label);
        });
      }
      await this.#finishOperation(lane, operationId, "completed");
      return ok({
        runId: operationId,
        kind: "completed",
        newLeafId: await this.#durableSession.view(lane).getLeafId(),
        ...(summaryEntry === undefined ? {} : { summaryEntry }),
      });
    } catch (error: unknown) {
      const failure = operationError(error);
      await this.#finishOperation(
        lane,
        operationId,
        authority.signal.aborted ? "aborted" : "failed",
        failure,
      ).catch(() => undefined);
      if (authority.signal.aborted) {
        return ok({ runId: operationId, kind: "aborted", leafId: oldLeafId });
      }
      return ok({ runId: operationId, kind: "failed", leafId: oldLeafId, error: failure });
    } finally {
      await authority.close();
    }
  }

  async #laneResume(lane: string): Promise<ResumeResult> {
    if (this.#closed) return err(this.#closedError());
    if (this.#active.has(lane)) return err((await this.#busy(lane))!);
    const open = await this.#durableSession.findOpenOperations(lane, { limit: 2 });
    if (open.length === 0) {
      return err(new NothingToResume({ lane, message: "The lane has no suspended operation" }));
    }
    if (open.length > 1) {
      this.#faulted = true;
      return err(
        new MissingIdentities({
          lane,
          tools: [],
          models: [],
          message: "The lane contains multiple unfinished operations",
        }),
      );
    }
    const operation = open[0]!;
    const authority = await this.#options.authorityProvider.acquire(this.#options.scope);
    let authorityTransferred = false;
    try {
      await authority.assertCurrent();
      if (operation.intent.kind === "run") {
        const runContext: DurableRunContext = {
          originalPrompt: operation.intent.originalPrompt,
          ...(operation.intent.systemPromptOverride === undefined
            ? {}
            : { systemPromptOverride: operation.intent.systemPromptOverride }),
          ...(operation.intent.resumeData === undefined
            ? {}
            : { resumeData: operation.intent.resumeData }),
        };
        await this.#runBeforeResumeHook(lane, operation.id, runContext, authority);
        const latestMessage = await this.#durableSession.view(lane).findEntryOnBranch({
          type: "message",
          order: "newestFirst",
        });
        if (
          latestMessage?.type === "message" &&
          isAssistant(latestMessage.message) &&
          latestMessage.message.stopReason === "deferred" &&
          latestMessage.message.deferred !== undefined
        ) {
          if (this.#options.models === undefined) {
            return err(
              new MissingIdentities({
                lane,
                tools: [],
                models: [`${this.#model.provider}/${this.#model.id}`],
                message: "Deferred response recovery requires the owning Pi Models provider",
              }),
            );
          }
          const deferred = latestMessage.message.deferred;
          if (
            deferred.provider !== latestMessage.message.provider ||
            deferred.modelId !== latestMessage.message.model ||
            deferred.api !== latestMessage.message.api
          ) {
            throw new Error(
              "Deferred response identity does not match its durable assistant message",
            );
          }
          const deferredModel = this.#options.models.getModel(deferred.provider, deferred.modelId);
          if (deferredModel === undefined) {
            return err(
              new MissingIdentities({
                lane,
                tools: [],
                models: [`${deferred.provider}/${deferred.modelId}`],
                message: "Deferred response recovery is missing its registered model identity",
              }),
            );
          }
          const fetched = await this.#performAction(
            { kind: "fetch_deferred", provider: deferred.provider, id: deferred.id },
            async () =>
              this.#options.models!.fetchDeferred(deferredModel, deferred, {
                signal: authority.signal,
              }),
          );
          const entryId = this.#id();
          const durableFetched = normalizeDurableMessage(fetched) as AssistantMessage;
          await this.#durableSession.appendEntry(
            { id: entryId, type: "message", message: durableFetched },
            lane,
          );
          await this.#recordAssistantUsage(
            lane,
            operation.id,
            entryId,
            durableFetched,
            "deferred_fetch",
          );
          if (durableFetched.stopReason === "deferred" && durableFetched.deferred !== undefined) {
            return ok({
              operation: "run",
              runId: operation.id,
              kind: "suspended",
              leafId: await this.#requireLeaf(lane),
              finalEntryId: entryId,
              deferred: durableFetched.deferred,
            });
          }
          const fetchedOutcome = assistantOutcome(durableFetched);
          if (durableFetched.stopReason === "toolUse") {
            const recovered = await this.#recoverInterruptedTools(lane, operation.id, authority);
            if (recovered.missingTools.length > 0) {
              return err(
                new MissingIdentities({
                  lane,
                  tools: recovered.missingTools,
                  models: [],
                  message: "Deferred Tool continuation is missing registered Tool identities",
                }),
              );
            }
            const execution = this.#executeRun(
              lane,
              operation.id,
              operation.intent.initialMessages,
              authority,
              runContext,
            );
            const result = await this.#trackOperation(
              lane,
              operation.id,
              "run",
              authority,
              execution,
            );
            authorityTransferred = true;
            return result.ok
              ? ok({ operation: "run", ...result.value })
              : err(
                  new MissingIdentities({
                    lane,
                    tools: [],
                    models: [],
                    message: result.error.message,
                  }),
                );
          }
          await this.#finishOperation(lane, operation.id, fetchedOutcome);
          return ok({
            operation: "run",
            runId: operation.id,
            kind: fetchedOutcome,
            leafId: await this.#requireLeaf(lane),
            finalEntryId: entryId,
            finalMessage: durableFetched,
            ...(fetchedOutcome === "failed"
              ? {
                  error: {
                    code: "model_error",
                    message: durableFetched.errorMessage ?? "Deferred request failed",
                  },
                }
              : {}),
          } as ResumeResult extends { ok: true; value: infer TValue } ? TValue : never);
        }
        const recovered = await this.#recoverInterruptedTools(lane, operation.id, authority);
        if (recovered.missingTools.length > 0) {
          return err(
            new MissingIdentities({
              lane,
              tools: recovered.missingTools,
              models: [],
              message: "Run recovery is missing registered Tool identities",
            }),
          );
        }
        const last = latestMessage;
        if (
          last?.type === "message" &&
          isAssistant(last.message) &&
          last.message.stopReason === "stop"
        ) {
          await this.#finishOperation(lane, operation.id, "completed");
          return ok({
            operation: "run",
            runId: operation.id,
            kind: "completed",
            leafId: await this.#requireLeaf(lane),
            finalEntryId: last.id,
            finalMessage: last.message,
          });
        }
        const execution = this.#executeRun(
          lane,
          operation.id,
          operation.intent.initialMessages,
          authority,
          runContext,
        );
        const result = await this.#trackOperation(lane, operation.id, "run", authority, execution);
        authorityTransferred = true;
        return result.ok
          ? ok({ operation: "run", ...result.value })
          : err(
              new MissingIdentities({
                lane,
                tools: [],
                models: [],
                message: result.error.message,
              }),
            );
      }
      if (operation.intent.kind === "compaction") {
        const entries = await this.#durableSession
          .view(lane)
          .findEntriesOnBranch({ order: "oldestFirst" });
        const preparation = prepareCompaction(entries, this.#compaction);
        if (!preparation.ok || preparation.value === undefined) {
          const failure = preparation.ok
            ? { code: "nothing_to_compact", message: "Compaction input no longer exists" }
            : operationError(preparation.error);
          await this.#finishOperation(lane, operation.id, "failed", failure);
          return ok({
            operation: "compaction",
            runId: operation.id,
            kind: "failed",
            leafId: await this.#requireLeaf(lane),
            error: failure,
          });
        }
        const execution = this.#executeCompaction(
          lane,
          operation.id,
          operation.intent.resultEntryId,
          preparation.value,
          authority,
          operation.intent.customInstructions,
          "manual",
        );
        const result = await this.#trackOperation(
          lane,
          operation.id,
          "compaction",
          authority,
          execution,
        );
        authorityTransferred = true;
        return result.ok
          ? ok({ operation: "compaction", ...result.value })
          : err(
              new MissingIdentities({
                lane,
                tools: [],
                models: [],
                message: result.error.message,
              }),
            );
      }
      const execution = this.#executeNavigation(
        lane,
        operation.id,
        operation.intent.targetId,
        {
          summarize: operation.intent.summarize,
          ...(operation.intent.customInstructions === undefined
            ? {}
            : { customInstructions: operation.intent.customInstructions }),
          ...(operation.intent.label === undefined ? {} : { label: operation.intent.label }),
        },
        operation.intent.summaryEntryId,
        authority,
      );
      const result = await this.#trackOperation(
        lane,
        operation.id,
        "navigation",
        authority,
        execution,
      );
      authorityTransferred = true;
      return result.ok
        ? ok({ operation: "navigation", ...result.value })
        : err(
            new MissingIdentities({
              lane,
              tools: [],
              models: [],
              message: result.error.message,
            }),
          );
    } finally {
      if (!authorityTransferred) await authority.close();
    }
  }

  async #laneAbort(lane: string): Promise<AbortResult> {
    if (this.#closed) return err(this.#closedError());
    const active = this.#active.get(lane);
    const [open] = await this.#durableSession.findOpenOperations(lane, { limit: 1 });
    if (active === undefined && open === undefined) {
      return err(new NoActiveOperation({ lane, message: "The lane has no active operation" }));
    }
    const runId = active?.id ?? open!.id;
    const steer = (await this.#pendingQueue(lane, "steer")).map((item) => item.message);
    const followUp = (await this.#pendingQueue(lane, "followUp")).map((item) => item.message);
    await this.#durableSession.appendRecord({
      id: this.#id(),
      lane,
      type: "abort_requested",
      runId,
    });
    const latest = await this.#durableSession.view(lane).findEntryOnBranch({
      type: "message",
      order: "newestFirst",
    });
    if (
      latest?.type === "message" &&
      isAssistant(latest.message) &&
      latest.message.stopReason === "deferred" &&
      latest.message.deferred !== undefined &&
      this.#options.models !== undefined
    ) {
      const deferred = latest.message.deferred;
      const deferredModel = this.#options.models.getModel(deferred.provider, deferred.modelId);
      if (deferredModel !== undefined) {
        await this.#performAction(
          { kind: "cancel_deferred", provider: deferred.provider, id: deferred.id },
          async () => this.#options.models!.cancelDeferred(deferredModel, deferred),
        ).catch(() => undefined);
      }
    }
    for (const item of [
      ...(await this.#pendingQueue(lane, "steer")),
      ...(await this.#pendingQueue(lane, "followUp")),
    ]) {
      await this.#durableSession.appendRecord({
        id: this.#id(),
        lane,
        type: "queue_cancelled",
        runId,
        entryId: item.entryId,
      });
    }
    active?.agent?.clearAllQueues();
    active?.agent?.abort();
    if (active !== undefined) await active.promise.catch(() => undefined);
    else await this.#finishOperation(lane, runId, "aborted");
    return ok({ runId, steer, followUp });
  }

  async #enqueue(
    lane: string,
    queue: "steer" | "followUp" | "nextRun",
    input: string | AgentMessage,
    images?: ImageContent[],
  ): Promise<QueueResult> {
    if (this.#closed) return err(this.#closedError());
    const [message] = normalizeMessages(input, images) ?? [];
    if (message === undefined) {
      return err(new InvalidMessage({ lane, reason: "invalid", message: "Queue item is invalid" }));
    }
    const active = this.#active.get(lane);
    if (
      queue !== "nextRun" &&
      (active === undefined || active.kind !== "run" || active.agent === undefined)
    ) {
      return err(new NoActiveRun({ lane, message: "The lane has no active Agent Run" }));
    }
    const entryId = this.#id();
    this.#queuedMessageIds.set(message as object, entryId);
    const target: ProvisionedEntry = { id: entryId, type: "message", message };
    await this.#durableSession.appendRecord(
      queue === "nextRun"
        ? { id: this.#id(), lane, type: "queue_enqueued", queue, target }
        : { id: this.#id(), lane, type: "queue_enqueued", queue, runId: active!.id, target },
    );
    if (queue === "steer") active!.agent!.steer(message);
    if (queue === "followUp") active!.agent!.followUp(message);
    await this.#emitEvent("queue_enqueued", { type: "queue_enqueued", lane, queue, entryId });
    return ok({ entryId });
  }

  async #laneCancelQueued(lane: string, entryId: string): Promise<CancelQueuedResult> {
    if (this.#closed) return err(this.#closedError());
    const enqueued = (
      await this.#durableSession.findRecords({ lane, type: "queue_enqueued", order: "newestFirst" })
    ).find((record) => record.target.id === entryId);
    if (enqueued === undefined) {
      return err(
        new UnknownQueueItem({ lane, entryId, message: `Unknown queue item: ${entryId}` }),
      );
    }
    if ((await this.#durableSession.getEntry(entryId)) !== undefined) {
      return ok({ outcome: "already_consumed" as const });
    }
    const cancelled = (
      await this.#durableSession.findRecords({
        lane,
        type: "queue_cancelled",
        order: "newestFirst",
      })
    ).some((record) => record.entryId === entryId);
    if (cancelled) return ok({ outcome: "already_cleared" as const });
    await this.#durableSession.appendRecord({
      id: this.#id(),
      lane,
      type: "queue_cancelled",
      ...(enqueued.queue === "nextRun" ? {} : { runId: enqueued.runId }),
      entryId,
    });
    return ok({ outcome: "cancelled" as const });
  }

  async #maybeCompact(lane: string, authority: DurableAgentExecutionAuthority): Promise<void> {
    if (!this.#compaction.enabled) return;
    const path = await this.#durableSession
      .view(lane)
      .findEntriesOnBranch({ order: "oldestFirst" });
    const context = await this.#buildContext(path);
    const usage = context.messages.reduce((total, message) => {
      if (message.role !== "assistant") return total;
      return Math.max(total, message.usage.totalTokens);
    }, 0);
    const model = await this.#laneModel(lane);
    if (!shouldCompact(usage, model.contextWindow, this.#compaction)) return;
    const preparation = prepareCompaction(path, this.#compaction);
    if (!preparation.ok || preparation.value === undefined) return;
    const operationId = this.#id();
    const resultEntryId = this.#id();
    await this.#durableSession.appendRecord({
      id: operationId,
      lane,
      type: "operation_started",
      sourceLeafId: await this.#durableSession.view(lane).getLeafId(),
      intent: { kind: "compaction", resultEntryId },
    });
    await this.#executeCompaction(
      lane,
      operationId,
      resultEntryId,
      preparation.value,
      authority,
      undefined,
      "threshold",
      false,
    );
  }

  async #recordAssistantUsage(
    lane: string,
    runId: string,
    entryId: string,
    message: AssistantMessage,
    cause: "assistant" | "deferred_fetch" = "assistant",
  ): Promise<void> {
    const attempts = await this.#durableSession.findRecords({ lane, type: "step_attempt", runId });
    await this.#durableSession.appendRecord({
      id: this.#id(),
      lane,
      type: "usage",
      cause,
      runId,
      entryId,
      attempt: Math.max(1, attempts.filter((record) => record.step === "assistant").length),
      stopReason: message.stopReason === "pending" ? "error" : message.stopReason,
      usage: message.usage,
    });
  }

  async #runBeforeToolHooks(input: {
    lane: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    tool: HarnessTool | undefined;
    args: Record<string, unknown>;
    signal: AbortSignal | undefined;
  }): Promise<{
    args: Record<string, unknown>;
    blocked?: { reason: string; terminate?: boolean };
  }> {
    return this.#hookRegistry.pipeline(
      "before_tool",
      { args: structuredClone(input.args) } as {
        args: Record<string, unknown>;
        blocked?: { reason: string; terminate?: boolean };
      },
      (current) => ({
        lane: input.lane,
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: structuredClone(current.args),
        signal: input.signal,
      }),
      (current, value) => {
        if (!isObject(value)) return { state: current };
        let args = current.args;
        if (isObject(value.args) && input.tool !== undefined) {
          args = validateToolArguments(input.tool, {
            type: "toolCall",
            id: input.toolCallId,
            name: input.toolName,
            arguments: value.args,
          }) as Record<string, unknown>;
        }
        let blocked = current.blocked;
        if (isObject(value.block) && typeof value.block.reason === "string") {
          blocked = {
            reason: value.block.reason,
            ...(value.block.terminate === true ? { terminate: true } : {}),
          };
        } else if (value.block === true) {
          blocked = {
            reason: typeof value.reason === "string" ? value.reason : "Tool execution was blocked",
            ...(value.terminate === true ? { terminate: true } : {}),
          };
        }
        return {
          state: { args, ...(blocked === undefined ? {} : { blocked }) },
          ...(blocked === undefined ? {} : { stop: true }),
        };
      },
      (current, error) => ({
        ...current,
        blocked: {
          reason: `Tool policy hook failed closed: ${operationError(error).message}`,
        },
      }),
    );
  }

  async #runAfterToolHooks(input: {
    lane: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: AgentToolResult<unknown>;
    isError: boolean;
    signal: AbortSignal | undefined;
  }): Promise<{
    result: AgentToolResult<unknown>;
    isError: boolean;
    changed: boolean;
  }> {
    return this.#hookRegistry.fold<{
      result: AgentToolResult<unknown>;
      isError: boolean;
      changed: boolean;
    }>(
      "after_tool",
      { result: input.result, isError: input.isError, changed: false },
      (current) => ({
        lane: input.lane,
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: structuredClone(input.args),
        content: current.result.content,
        details: current.result.details,
        isError: current.isError,
        usage: current.result.usage,
        signal: input.signal,
      }),
      (current, value) => {
        if (!isObject(value)) return current;
        return {
          result: {
            ...current.result,
            ...(Array.isArray(value.content)
              ? { content: value.content as AgentToolResult<unknown>["content"] }
              : {}),
            ...(Object.hasOwn(value, "details") ? { details: value.details } : {}),
            ...(isObject(value.usage) ? { usage: value.usage as unknown as Usage } : {}),
            ...(typeof value.terminate === "boolean" ? { terminate: value.terminate } : {}),
          },
          isError: typeof value.isError === "boolean" ? value.isError : current.isError,
          changed: true,
        };
      },
    );
  }

  #bindTool(
    tool: HarnessTool,
    authority: DurableAgentExecutionAuthority,
    lane: string,
    runId: string,
    state: ToolExecutionState,
  ): HarnessTool {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        await authority.assertCurrent();
        const assistantEntryId = state.getAssistantEntryId();
        if (assistantEntryId === undefined) {
          throw new Error("Tool execution started before its assistant message was durable");
        }
        const effectiveArgs =
          state.decisions.get(toolCallId)?.args ?? (isObject(params) ? params : {});
        const resultEntryId = this.#id();
        await this.#performAction(
          { kind: "append_record", recordType: "tool_started" },
          async () => {
            await authority.assertCurrent();
            await this.#durableSession.appendRecord({
              id: this.#id(),
              lane,
              type: "tool_started",
              runId,
              assistantEntryId,
              toolIndex: state.nextToolIndex(),
              toolCallId,
              toolName: tool.name,
              effectiveArgs: structuredClone(effectiveArgs),
              resultEntryId,
              replay: tool.replay ?? "never",
            });
          },
        );
        state.resultEntryIds.set(toolCallId, resultEntryId);
        const effectSignal = combinedSignal(signal, authority.signal);
        const result = await this.#performAction(
          { kind: "execute_tool", toolCallId, toolName: tool.name },
          async () => tool.execute(toolCallId, effectiveArgs, effectSignal, onUpdate),
        );
        await authority.assertCurrent();
        return result;
      },
    };
  }

  async #finishOperation(
    lane: string,
    runId: string,
    outcome: "completed" | "aborted" | "failed" | "declined",
    error?: { code: string; message: string },
  ): Promise<void> {
    const already = await this.#durableSession.findRecords({
      lane,
      type: "operation_finished",
      runId,
      limit: 1,
    });
    if (already.length > 0) return;
    await this.#performAction({ kind: "finish_operation", outcome }, async () => {
      await this.#durableSession.appendRecord({
        id: this.#id(),
        lane,
        type: "operation_finished",
        runId,
        outcome,
        ...(error === undefined ? {} : { error }),
      });
    });
  }

  #trackOperation<T>(
    lane: string,
    id: string,
    kind: OperationKind,
    authority: DurableAgentExecutionAuthority,
    promise: Promise<T>,
  ): Promise<T> {
    const active: ActiveOperation = { id, kind, authority, promise };
    this.#active.set(lane, active);
    const tracked = promise.finally(async () => {
      if (this.#active.get(lane)?.id === id) this.#active.delete(lane);
      this.#notifyActionWaiters();
      this.#notifyIdleWaiters();
      await this.#emitEvent("operation_settled", { type: "operation_settled", lane, runId: id });
    });
    active.promise = tracked;
    return tracked;
  }

  async #busy(lane: string): Promise<LaneBusy | undefined> {
    const active = this.#active.get(lane);
    if (active !== undefined) {
      return new LaneBusy({
        lane,
        operationId: active.id,
        operationKind: active.kind,
        message: `Lane ${lane} is busy`,
      });
    }
    const [open] = await this.#durableSession.findOpenOperations(lane, { limit: 1 });
    if (open === undefined) return undefined;
    return new LaneBusy({
      lane,
      operationId: open.id,
      operationKind: open.intent.kind,
      message: `Lane ${lane} has a suspended operation`,
    });
  }

  async #pendingQueue(
    lane: string,
    queue: "steer" | "followUp" | "nextRun",
  ): Promise<Array<{ entryId: string; message: AgentMessage }>> {
    const enqueued = await this.#durableSession.findRecords({ lane, type: "queue_enqueued" });
    const cancelled = new Set(
      (await this.#durableSession.findRecords({ lane, type: "queue_cancelled" })).map(
        (record) => record.entryId,
      ),
    );
    const result: Array<{ entryId: string; message: AgentMessage }> = [];
    for (const record of enqueued) {
      if (record.queue !== queue || cancelled.has(record.target.id)) continue;
      if ((await this.#durableSession.getEntry(record.target.id)) !== undefined) continue;
      if (record.target.type !== "message") continue;
      this.#queuedMessageIds.set(record.target.message as object, record.target.id);
      result.push({ entryId: record.target.id, message: record.target.message });
    }
    return result;
  }

  async #consumeQueueEntry(lane: string, runId: string, entryId: string): Promise<void> {
    const enqueued = (
      await this.#durableSession.findRecords({ lane, type: "queue_enqueued", order: "newestFirst" })
    ).find((record) => record.target.id === entryId);
    if (enqueued === undefined) return;
    const cancelled = (
      await this.#durableSession.findRecords({
        lane,
        type: "queue_cancelled",
        order: "newestFirst",
      })
    ).some((record) => record.entryId === entryId);
    if (cancelled) return;
    await this.#performAction(
      {
        kind: "consume_queue_item",
        queue: enqueued.queue === "nextRun" ? "followUp" : enqueued.queue,
        entryId,
      },
      async () => {
        await this.#durableSession.appendRecord({
          id: this.#id(),
          lane,
          type: "queue_cancelled",
          runId,
          entryId,
        });
      },
    );
  }

  async #unresolvedTools(runId: string) {
    const tools = await this.#durableSession.findRecords({ type: "tool_started", runId });
    const unresolved = [];
    for (const tool of tools) {
      if ((await this.#durableSession.getEntry(tool.resultEntryId)) === undefined)
        unresolved.push(tool);
    }
    return unresolved;
  }

  async #requiredRecoveryToolNames(lane: string, runId: string): Promise<string[]> {
    const required = new Set<string>();
    for (const started of await this.#unresolvedTools(runId)) {
      if (started.replay === "safe") required.add(started.toolName);
    }
    const latest = await this.#durableSession.view(lane).findEntryOnBranch({
      type: "message",
      order: "newestFirst",
    });
    if (
      latest?.type !== "message" ||
      !isAssistant(latest.message) ||
      latest.message.stopReason !== "toolUse"
    ) {
      return [...required];
    }
    const starts = await this.#durableSession.findRecords({
      lane,
      type: "tool_started",
      runId,
    });
    for (const call of latest.message.content) {
      if (call.type !== "toolCall") continue;
      const started = starts.find(
        (candidate) => candidate.assistantEntryId === latest.id && candidate.toolCallId === call.id,
      );
      if (started === undefined) required.add(call.name);
    }
    return [...required];
  }

  async #recoverInterruptedTools(
    lane: string,
    runId: string,
    authority: DurableAgentExecutionAuthority,
  ): Promise<{ recovered: boolean; missingTools: string[] }> {
    const branch = await this.#durableSession.view(lane).findEntriesOnBranch({
      order: "newestFirst",
    });
    const assistantEntry = branch.find(
      (entry) =>
        entry.type === "message" &&
        isAssistant(entry.message) &&
        entry.message.stopReason === "toolUse",
    );
    if (assistantEntry?.type !== "message" || !isAssistant(assistantEntry.message)) {
      return { recovered: false, missingTools: [] };
    }
    const calls = assistantEntry.message.content.filter(
      (content): content is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
        content.type === "toolCall",
    );
    const starts = (
      await this.#durableSession.findRecords({ lane, type: "tool_started", runId })
    ).filter((record) => record.assistantEntryId === assistantEntry.id);
    const unresolved = [];
    for (const call of calls) {
      const started = starts.find((record) => record.toolCallId === call.id);
      if (started !== undefined && (await this.#durableSession.getEntry(started.resultEntryId))) {
        continue;
      }
      unresolved.push({ call, started });
    }
    if (unresolved.length === 0) return { recovered: false, missingTools: [] };

    const missingTools = unresolved
      .filter(({ started }) => started?.replay !== "never")
      .map(({ call }) => call.name)
      .filter(
        (name) =>
          !this.#activeToolNames.includes(name) ||
          !this.#tools.some((candidate) => candidate.name === name),
      );
    if (missingTools.length > 0) {
      return { recovered: false, missingTools: [...new Set(missingTools)] };
    }

    for (const { call, started } of unresolved) {
      await authority.assertCurrent();
      const tool = this.#tools.find((candidate) => candidate.name === call.name);
      const resultEntryId = started?.resultEntryId ?? this.#id();
      let result: AgentToolResult<unknown>;
      let isError = false;

      if (started?.replay === "never") {
        result = {
          content: [
            {
              type: "text",
              text:
                `Tool ${call.name} was interrupted after execution may have started. ` +
                "Its side effects are unknown; inspect the current environment before deciding what to do next.",
            },
          ],
          details: { interrupted: true, effect: "unknown" },
        };
        isError = true;
      } else {
        if (tool === undefined) throw new Error(`Tool ${call.name} disappeared during recovery`);
        let args = started?.effectiveArgs ?? (isObject(call.arguments) ? call.arguments : {});
        let blocked: { reason: string; terminate?: boolean } | undefined;
        if (started === undefined) {
          const decision = await this.#performAction(
            { kind: "hook", name: "before_tool" },
            async () =>
              this.#runBeforeToolHooks({
                lane,
                runId,
                toolCallId: call.id,
                toolName: call.name,
                tool,
                args,
                signal: authority.signal,
              }),
          );
          args = decision.args;
          blocked = decision.blocked;
          if (blocked === undefined) {
            await this.#performAction(
              { kind: "append_record", recordType: "tool_started" },
              async () => {
                await authority.assertCurrent();
                await this.#durableSession.appendRecord({
                  id: this.#id(),
                  lane,
                  type: "tool_started",
                  runId,
                  assistantEntryId: assistantEntry.id,
                  toolIndex: calls.findIndex((candidate) => candidate.id === call.id),
                  toolCallId: call.id,
                  toolName: call.name,
                  effectiveArgs: structuredClone(args),
                  resultEntryId,
                  replay: tool.replay ?? "never",
                });
              },
            );
          }
        }
        if (blocked !== undefined) {
          result = {
            content: [{ type: "text", text: blocked.reason }],
            details: { blocked: true },
            ...(blocked.terminate === undefined ? {} : { terminate: blocked.terminate }),
          };
          isError = true;
        } else {
          try {
            result = await this.#performAction(
              { kind: "execute_tool", toolCallId: call.id, toolName: call.name },
              async () => tool.execute(call.id, args, authority.signal),
            );
          } catch (error: unknown) {
            result = {
              content: [{ type: "text", text: operationError(error).message }],
              details: {},
            };
            isError = true;
          }
          await authority.assertCurrent();
          const patched = await this.#performAction(
            { kind: "hook", name: "after_tool" },
            async () =>
              this.#runAfterToolHooks({
                lane,
                runId,
                toolCallId: call.id,
                toolName: call.name,
                args,
                result,
                isError,
                signal: authority.signal,
              }),
          );
          result = patched.result;
          isError = patched.isError;
        }
      }

      const message: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        details: result.details,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.addedToolNames === undefined ? {} : { addedToolNames: result.addedToolNames }),
        isError,
        timestamp: Date.now(),
      };
      await this.#performAction(
        { kind: "append_entry", entryType: "message", entryId: resultEntryId },
        async () => {
          await authority.assertCurrent();
          await this.#durableSession.appendEntry(
            { id: resultEntryId, type: "message", message },
            lane,
          );
        },
      );
      if (result.usage !== undefined) {
        await this.#durableSession.appendRecord({
          id: this.#id(),
          lane,
          type: "usage",
          cause: "tool",
          runId,
          entryId: resultEntryId,
          toolCallId: call.id,
          usage: result.usage,
        });
      }
    }
    return { recovered: true, missingTools: [] };
  }

  async #suspendedOperations(): Promise<SuspendedOperation[]> {
    const suspended: SuspendedOperation[] = [];
    for (const lane of await this.#durableSession.getLanes()) {
      const open = await this.#durableSession.findOpenOperations(lane.lane, { limit: 2 });
      if (open.length > 1) this.#faulted = true;
      for (const operation of open.slice(0, 1)) {
        const requiredTools =
          operation.intent.kind === "run"
            ? await this.#requiredRecoveryToolNames(lane.lane, operation.id)
            : [];
        const missingTools = requiredTools.filter(
          (name) => !this.#tools.some((tool) => tool.name === name),
        );
        const latest = await this.#durableSession.view(lane.lane).findEntryOnBranch({
          type: "message",
          order: "newestFirst",
        });
        const deferred =
          latest?.type === "message" &&
          isAssistant(latest.message) &&
          latest.message.stopReason === "deferred"
            ? latest.message.deferred
            : undefined;
        const missingModels =
          deferred !== undefined &&
          this.#options.models?.getModel(deferred.provider, deferred.modelId) === undefined
            ? [`${deferred.provider}/${deferred.modelId}`]
            : [];
        suspended.push({
          lane: lane.lane,
          kind: operation.intent.kind,
          id: operation.id,
          startedAt: operation.timestamp,
          reason: deferred === undefined ? "crash" : "deferred",
          ...(operation.intent.kind === "run" ? { prompt: operation.intent.originalPrompt } : {}),
          ...(deferred === undefined ? {} : { deferred }),
          missing: { tools: [...new Set(missingTools)], models: missingModels },
        });
      }
    }
    return suspended;
  }

  async #laneInfo(lane: string, leafId?: string | null): Promise<LaneInfo> {
    const active = this.#active.get(lane);
    if (active !== undefined) {
      return {
        name: lane,
        leafId: leafId ?? (await this.#durableSession.view(lane).getLeafId()),
        operation: { id: active.id, kind: active.kind, status: "running" },
      };
    }
    const [open] = await this.#durableSession.findOpenOperations(lane, { limit: 1 });
    return {
      name: lane,
      leafId: leafId ?? (await this.#durableSession.view(lane).getLeafId()),
      operation:
        open === undefined ? null : { id: open.id, kind: open.intent.kind, status: "suspended" },
    };
  }

  async #laneSnapshot(lane: string): Promise<LaneSnapshot> {
    const transcript = await this.#durableSession.view(lane).findEntriesOnBranch({
      order: "oldestFirst",
    });
    const info = await this.#laneInfo(lane);
    const deferred = await this.#durableSession.findRecords({ lane, type: "write_deferred" });
    return {
      lane,
      transcript,
      leafId: info.leafId,
      operation: info.operation,
      queues: {
        steer: await this.#pendingQueue(lane, "steer"),
        followUp: await this.#pendingQueue(lane, "followUp"),
        nextRun: await this.#pendingQueue(lane, "nextRun"),
      },
      pendingWrites: deferred.map((record) => ({ id: record.id, entry: record.target })),
      faulted: this.#faulted,
    };
  }

  async #sessionSnapshot(): Promise<SessionSnapshot> {
    const suspended = await this.#suspendedOperations();
    const infos = await this.lanes();
    return {
      lanes: infos.map((info) => ({
        ...info,
        ...(suspended.find((operation) => operation.lane === info.name) === undefined
          ? {}
          : { suspended: suspended.find((operation) => operation.lane === info.name)! }),
      })),
      faulted: this.#faulted,
    };
  }

  async #watchLane(lane: string): Promise<WatchHandle<LaneSnapshot>> {
    const handle = new MutableWatchHandle(await this.#laneSnapshot(lane), () => undefined);
    const unsubscribe = this.#eventRegistry.on("*", async () => {
      handle.update(await this.#laneSnapshot(lane));
    });
    handle.setUnsubscribe(unsubscribe);
    return handle;
  }

  async #emitEvent(type: string, event: unknown): Promise<void> {
    await this.#eventRegistry.emit(type, event);
  }

  async #performAction<T>(info: ActionInfo, task: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new HarnessClosed();
    if ((this.#options.drive ?? "automatic") === "automatic") return task();
    return new Promise<T>((resolvePromise, rejectPromise) => {
      this.#actions.push({
        info,
        run: async () => {
          try {
            resolvePromise(await task());
          } catch (error: unknown) {
            rejectPromise(error);
          }
        },
        reject: rejectPromise,
      });
      this.#notifyActionWaiters();
    });
  }

  async #waitForActionOrIdle(): Promise<void> {
    if (
      this.#actions.length > 0 ||
      (this.#pendingOperationStarts === 0 && this.#active.size === 0)
    ) {
      return;
    }
    await new Promise<void>((resolvePromise) => this.#actionWaiters.add(resolvePromise));
  }

  #notifyActionWaiters(): void {
    for (const waiter of this.#actionWaiters) waiter();
    this.#actionWaiters.clear();
  }

  #notifyIdleWaiters(): void {
    for (const waiter of this.#idleWaiters) waiter();
    this.#idleWaiters.clear();
  }

  #models(): Models {
    if (this.#options.models !== undefined) return this.#options.models;
    const streamFn = this.#options.streamFn;
    if (streamFn === undefined) {
      throw new Error("DurableAgentHarness has no Pi Models or streamFn adapter");
    }
    return {
      streamSimple: (model, context, options) => streamFn(model, context, options),
      completeSimple: async (model, context, options) =>
        (await streamFn(model, context, options)).result(),
    } as Models;
  }

  async #buildContext(path: Entry[]): Promise<ReturnType<typeof buildSessionContext>> {
    const state = buildSessionContext(path);
    if (this.#options.entryProjectors === undefined) return state;
    const entries = buildContextEntries(path);
    const messages: AgentMessage[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type === "custom") {
        const projector = this.#options.entryProjectors[entry.customType];
        if (projector !== undefined) {
          messages.push(...(await projector(entry)));
          continue;
        }
      }
      messages.push(...sessionEntryToContextMessages(entry, index, entries));
    }
    return { ...state, messages };
  }

  #modelKey(provider: string, modelId: string): string {
    return `${provider}\u0000${modelId}`;
  }

  async #laneConfiguration(lane: string): Promise<ReturnType<typeof buildSessionContext>> {
    return buildSessionContext(
      await this.#durableSession.view(lane).findEntriesOnBranch({ order: "oldestFirst" }),
    );
  }

  async #laneModel(lane: string): Promise<Model<Api>> {
    const configured = (await this.#laneConfiguration(lane)).model;
    if (configured === null) return this.#model;
    const key = this.#modelKey(configured.provider, configured.modelId);
    const model =
      this.#knownModels.get(key) ??
      this.#options.models?.getModel(configured.provider, configured.modelId);
    if (model === undefined) {
      throw new Error(
        `Configured model is unavailable: ${configured.provider}/${configured.modelId}`,
      );
    }
    this.#knownModels.set(key, model);
    return model;
  }

  async #setLaneModel(lane: string, model: Model<Api>): Promise<void> {
    this.#assertMutableConfig(lane);
    this.#knownModels.set(this.#modelKey(model.provider, model.id), model);
    if (lane === "main") this.#model = model;
    await this.#durableSession.appendEntry(
      { id: this.#id(), type: "model_change", provider: model.provider, modelId: model.id },
      lane,
    );
  }

  async #laneThinkingLevel(lane: string): Promise<ThinkingLevel> {
    const path = await this.#durableSession
      .view(lane)
      .findEntriesOnBranch({ order: "oldestFirst" });
    if (!path.some((entry) => entry.type === "thinking_level_change")) {
      return this.#thinkingLevel;
    }
    const configured = buildSessionContext(path).thinkingLevel;
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(configured)
      ? (configured as ThinkingLevel)
      : this.#thinkingLevel;
  }

  async #setLaneThinkingLevel(lane: string, level: ThinkingLevel): Promise<void> {
    this.#assertMutableConfig(lane);
    if (lane === "main") this.#thinkingLevel = level;
    await this.#durableSession.appendEntry(
      { id: this.#id(), type: "thinking_level_change", thinkingLevel: level },
      lane,
    );
  }

  async #laneActiveTools(lane: string): Promise<string[]> {
    const configured = (await this.#laneConfiguration(lane)).activeToolNames;
    return configured === null ? [...this.#activeToolNames] : [...configured];
  }

  async #setLaneActiveTools(lane: string, names: string[]): Promise<void> {
    this.#assertMutableConfig(lane);
    this.#validateTools(this.#tools, names);
    if (lane === "main") this.#activeToolNames = [...names];
    await this.#durableSession.appendEntry(
      { id: this.#id(), type: "active_tools_change", activeToolNames: [...names] },
      lane,
    );
  }

  #validateTools(tools: readonly HarnessTool[], activeNames: readonly string[]): void {
    const duplicateTools = findDuplicates(tools.map((tool) => tool.name));
    const duplicateActive = findDuplicates(activeNames);
    if (duplicateTools.length > 0 || duplicateActive.length > 0) {
      throw new TypeError(
        `Duplicate Tool identity: ${[...duplicateTools, ...duplicateActive].join(", ")}`,
      );
    }
    const known = new Set(tools.map((tool) => tool.name));
    const missing = activeNames.filter((name) => !known.has(name));
    if (missing.length > 0) throw new TypeError(`Unknown active Tool(s): ${missing.join(", ")}`);
  }

  #assertMutableConfig(lane?: string): void {
    if (this.#closed) throw new Error("Durable Agent Harness is closed");
    if (lane === undefined ? this.#active.size > 0 : this.#active.has(lane))
      throw new Error("Harness configuration is frozen during an operation");
  }

  #closedError(): Closed {
    return new Closed({ message: "Durable Agent Harness is closed" });
  }

  async #requireLeaf(lane: string): Promise<string> {
    const leaf = await this.#durableSession.view(lane).getLeafId();
    if (leaf === null) throw new Error(`Lane ${lane} has no durable leaf`);
    return leaf;
  }

  // Lane facade entry points.
  _prompt(lane: string, input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
    return this.#lanePrompt(lane, input, images);
  }
  _compact(lane: string, options?: { customInstructions?: string }) {
    return this.#laneCompact(lane, options);
  }
  _navigate(lane: string, targetId: string | null, options?: NavigateOptions) {
    return this.#laneNavigate(lane, targetId, options);
  }
  _resume(lane: string) {
    return this.#laneResume(lane);
  }
  _abort(lane: string) {
    return this.#laneAbort(lane);
  }
  _enqueue(
    lane: string,
    queue: "steer" | "followUp" | "nextRun",
    input: string | AgentMessage,
    images?: ImageContent[],
  ) {
    return this.#enqueue(lane, queue, input, images);
  }
  _cancelQueued(lane: string, entryId: string): Promise<CancelQueuedResult> {
    return this.#laneCancelQueued(lane, entryId);
  }
  _watch(lane: string) {
    return this.#watchLane(lane);
  }
  _recordUsage(
    lane: string,
    usage: Usage,
    options?: { entryId?: string; details?: import("@earendil-works/pi-agent-core").JsonValue },
  ) {
    return this.#laneRecordUsage(lane, usage, options);
  }
  _tree(lane: string): SessionTree {
    return this.#durableSession.view(lane);
  }
  _getModel(lane: string) {
    return this.#laneModel(lane);
  }
  _setModel(lane: string, model: Model<Api>) {
    return this.#setLaneModel(lane, model);
  }
  _getThinkingLevel(lane: string) {
    return this.#laneThinkingLevel(lane);
  }
  _setThinkingLevel(lane: string, level: ThinkingLevel) {
    return this.#setLaneThinkingLevel(lane, level);
  }
  _getActiveTools(lane: string) {
    return this.#laneActiveTools(lane);
  }
  _setActiveTools(lane: string, names: string[]) {
    return this.#setLaneActiveTools(lane, names);
  }
}

class DurableAgentLane implements AgentLane {
  readonly #owner: DurableAgentHarness;
  readonly name: string;
  readonly session: SessionTree;

  constructor(owner: DurableAgentHarness, name: string) {
    this.#owner = owner;
    this.name = name;
    this.session = owner._tree(name);
  }

  getLeafId() {
    return this.session.getLeafId();
  }
  prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
  prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
  prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
    return this.#owner._prompt(this.name, input, images);
  }
  async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
    const resources = await this.#owner.getResources();
    const skill = resources.skills?.find((candidate) => candidate.name === name);
    if (skill === undefined) {
      return err(new UnknownSkill({ name, message: `Unknown skill: ${name}` }));
    }
    return this.prompt(formatSkillInvocation(skill, additionalInstructions));
  }
  async promptFromTemplate(name: string, args: string[] = []): Promise<RunResult> {
    const resources = await this.#owner.getResources();
    const template = resources.promptTemplates?.find((candidate) => candidate.name === name);
    if (template === undefined) {
      return err(new UnknownTemplate({ name, message: `Unknown prompt template: ${name}` }));
    }
    return this.prompt(formatPromptTemplateInvocation(template, args));
  }
  compact(options?: { customInstructions?: string }) {
    return this.#owner._compact(this.name, options);
  }
  navigateTree(targetId: string | null, options?: NavigateOptions) {
    return this.#owner._navigate(this.name, targetId, options);
  }
  resume() {
    return this.#owner._resume(this.name);
  }
  abort() {
    return this.#owner._abort(this.name);
  }
  steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
  steer(message: AgentMessage): Promise<QueueResult>;
  steer(input: string | AgentMessage, images?: ImageContent[]) {
    return this.#owner._enqueue(this.name, "steer", input, images);
  }
  followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
  followUp(message: AgentMessage): Promise<QueueResult>;
  followUp(input: string | AgentMessage, images?: ImageContent[]) {
    return this.#owner._enqueue(this.name, "followUp", input, images);
  }
  nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
  nextRun(message: AgentMessage): Promise<QueueResult>;
  nextRun(input: string | AgentMessage, images?: ImageContent[]) {
    return this.#owner._enqueue(this.name, "nextRun", input, images);
  }
  cancelQueued(entryId: string): Promise<CancelQueuedResult> {
    return this.#owner._cancelQueued(this.name, entryId);
  }
  recordUsage(
    usage: Usage,
    options?: { entryId?: string; details?: import("@earendil-works/pi-agent-core").JsonValue },
  ) {
    return this.#owner._recordUsage(this.name, usage, options);
  }
  waitForIdle() {
    return this.#owner.waitForIdle();
  }
  runWhenIdle(callback: () => void | Promise<void>) {
    return this.#owner.runWhenIdle(callback);
  }
  peekAction() {
    return this.#owner.peekAction();
  }
  executeAction() {
    return this.#owner.executeAction();
  }
  runToCompletion() {
    return this.#owner.runToCompletion();
  }
  getModel() {
    return this.#owner._getModel(this.name);
  }
  setModel(model: Model<Api>) {
    return this.#owner._setModel(this.name, model);
  }
  getThinkingLevel() {
    return this.#owner._getThinkingLevel(this.name);
  }
  setThinkingLevel(level: ThinkingLevel) {
    return this.#owner._setThinkingLevel(this.name, level);
  }
  getActiveTools() {
    return this.#owner._getActiveTools(this.name);
  }
  setActiveTools(names: string[]) {
    return this.#owner._setActiveTools(this.name, names);
  }
  watch() {
    return this.#owner._watch(this.name);
  }
}

class MutableWatchHandle<TSnapshot> implements WatchHandle<TSnapshot> {
  snapshot: TSnapshot;
  #listener: ((event: unknown) => void) | undefined;
  #unsubscribe: () => void;

  constructor(snapshot: TSnapshot, unsubscribe: () => void) {
    this.snapshot = snapshot;
    this.#unsubscribe = unsubscribe;
  }

  setUnsubscribe(unsubscribe: () => void): void {
    this.#unsubscribe = unsubscribe;
  }

  update(snapshot: TSnapshot): void {
    this.snapshot = snapshot;
    this.#listener?.({ type: "snapshot", snapshot });
  }

  start(listener: (event: unknown) => void): void {
    this.#listener = listener;
  }

  unsubscribe(): void {
    this.#listener = undefined;
    this.#unsubscribe();
  }
}
