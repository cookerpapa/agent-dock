import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type InlineExtension,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type EmbeddedPiCheckpoint = {
  sessionFile: string;
};

export type ExecuteEmbeddedCommand = {
  logicalSessionId: string;
  command: string;
  checkpoint?: EmbeddedPiCheckpoint;
};

export type EmbeddedPiExecutionResult = {
  logicalSessionId: string;
  piSessionId: string;
  activationId: number;
  backendInstanceId: string;
  workerPid: number;
  checkpoint: EmbeddedPiCheckpoint;
  restoredMessageCount: number;
  restoredMessageRoles: string[];
  finalMessageCount: number;
  entries: SessionEntry[];
};

export type EmbeddedPiBackendMetrics = {
  backendInstanceId: string;
  workerPid: number;
  activationCount: number;
  activeActivations: number;
  peakActiveActivations: number;
  waitingForCapacity: number;
  sessionLaneCount: number;
  knownSessionCount: number;
};

export type EmbeddedPiBackendOptions = {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  maxConcurrentActivations: number;
  extensionFactories: InlineExtension[];
};

class FairSemaphore {
  readonly #maximum: number;
  readonly #waiters: Array<(release: () => void) => void> = [];
  #active = 0;
  #peak = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("maxConcurrentActivations must be a positive safe integer");
    }
    this.#maximum = maximum;
  }

  get active(): number {
    return this.#active;
  }

  get peak(): number {
    return this.#peak;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  acquire(): Promise<() => void> {
    if (this.#active < this.#maximum) {
      this.#active += 1;
      this.#peak = Math.max(this.#peak, this.#active);
      return Promise.resolve(this.#createRelease());
    }

    return new Promise((resolvePromise) => {
      this.#waiters.push(resolvePromise);
    });
  }

  #createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        throw new Error("Embedded Pi activation capacity was released twice");
      }
      released = true;
      this.#active -= 1;
      const next = this.#waiters.shift();
      if (next) {
        this.#active += 1;
        this.#peak = Math.max(this.#peak, this.#active);
        next(this.#createRelease());
      }
    };
  }
}

function assertLogicalSessionId(value: string): void {
  if (value.length === 0 || value.length > 256) {
    throw new Error("logicalSessionId must contain between 1 and 256 characters");
  }
}

function assertExtensionCommand(value: string): void {
  if (!value.startsWith("/") || value.length < 2) {
    throw new Error("The embedded spike accepts extension commands only; LLM prompts are disabled");
  }
}

function assertOwnedCheckpoint(sessionDir: string, sessionFile: string): string {
  const candidateSessionFile = resolve(sessionFile);
  if (!existsSync(candidateSessionFile)) {
    throw new Error(`Checkpoint session file does not exist: ${candidateSessionFile}`);
  }
  const resolvedSessionDir = realpathSync(resolve(sessionDir));
  const resolvedSessionFile = realpathSync(candidateSessionFile);
  const relativePath = relative(resolvedSessionDir, resolvedSessionFile);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Checkpoint session file is outside the backend-owned session directory");
  }
  return resolvedSessionFile;
}

export class EmbeddedPiBackend {
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #sessionDir: string;
  readonly #extensionFactories: InlineExtension[];
  readonly #capacity: FairSemaphore;
  readonly #backendInstanceId = randomUUID();
  readonly #sessionTails = new Map<string, Promise<void>>();
  readonly #sessionFiles = new Map<string, string>();
  readonly #checkpointOwners = new Map<string, string>();
  #activationCount = 0;

  constructor(options: EmbeddedPiBackendOptions) {
    this.#cwd = resolve(options.cwd);
    this.#agentDir = resolve(options.agentDir);
    this.#sessionDir = resolve(options.sessionDir);
    this.#extensionFactories = [...options.extensionFactories];
    this.#capacity = new FairSemaphore(options.maxConcurrentActivations);
  }

  get metrics(): EmbeddedPiBackendMetrics {
    return {
      backendInstanceId: this.#backendInstanceId,
      workerPid: process.pid,
      activationCount: this.#activationCount,
      activeActivations: this.#capacity.active,
      peakActiveActivations: this.#capacity.peak,
      waitingForCapacity: this.#capacity.waiting,
      sessionLaneCount: this.#sessionTails.size,
      knownSessionCount: this.#sessionFiles.size,
    };
  }

  execute(input: ExecuteEmbeddedCommand): Promise<EmbeddedPiExecutionResult> {
    assertLogicalSessionId(input.logicalSessionId);
    assertExtensionCommand(input.command);
    return this.#inSessionLane(input.logicalSessionId, () => this.#activate(input));
  }

  async #activate(input: ExecuteEmbeddedCommand): Promise<EmbeddedPiExecutionResult> {
    const releaseCapacity = await this.#capacity.acquire();
    try {
      await Promise.all([
        mkdir(this.#cwd, { recursive: true }),
        mkdir(this.#agentDir, { recursive: true }),
        mkdir(this.#sessionDir, { recursive: true }),
      ]);

      const sessionFile = this.#resolveSessionFile(input);
      const sessionManager = sessionFile
        ? SessionManager.open(sessionFile, this.#sessionDir, this.#cwd)
        : SessionManager.create(this.#cwd, this.#sessionDir);
      const sessionStartEvent = sessionFile
        ? ({ type: "session_start", reason: "resume" } as const)
        : ({ type: "session_start", reason: "startup" } as const);

      const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
        const services = await createAgentSessionServices({
          cwd: runtimeOptions.cwd,
          agentDir: runtimeOptions.agentDir,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false },
          }),
          resourceLoaderOptions: {
            extensionFactories: [...this.#extensionFactories],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
          },
        });
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: runtimeOptions.sessionManager,
          sessionStartEvent: runtimeOptions.sessionStartEvent ?? sessionStartEvent,
          noTools: "all",
        });
        return {
          ...created,
          services,
          diagnostics: services.diagnostics,
        };
      };

      const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: this.#cwd,
        agentDir: this.#agentDir,
        sessionManager,
        sessionStartEvent,
      });
      const extensionErrors: ExtensionError[] = [];
      try {
        await runtime.session.bindExtensions({
          mode: "rpc",
          onError: (error) => {
            extensionErrors.push(error);
          },
        });
        const restoredMessageCount = runtime.session.messages.length;
        const restoredMessageRoles = runtime.session.messages.map((message) => message.role);
        const activationId = ++this.#activationCount;
        await runtime.session.prompt(input.command, { source: "rpc" });
        if (extensionErrors.length > 0) {
          throw new Error(
            extensionErrors
              .map((error) => `${error.extensionPath}:${error.event}: ${error.error}`)
              .join("; "),
          );
        }

        this.#ensureSyntheticSettledBoundary(runtime.session);

        const persistedSessionFile = runtime.session.sessionFile;
        if (!persistedSessionFile) {
          throw new Error("Embedded Pi activation did not produce a persistent session file");
        }
        const ownedSessionFile = assertOwnedCheckpoint(this.#sessionDir, persistedSessionFile);
        this.#rememberCheckpoint(input.logicalSessionId, ownedSessionFile);

        return {
          logicalSessionId: input.logicalSessionId,
          piSessionId: runtime.session.sessionId,
          activationId,
          backendInstanceId: this.#backendInstanceId,
          workerPid: process.pid,
          checkpoint: { sessionFile: ownedSessionFile },
          restoredMessageCount,
          restoredMessageRoles,
          finalMessageCount: runtime.session.messages.length,
          entries: runtime.session.sessionManager.getEntries(),
        };
      } finally {
        await runtime.dispose();
      }
    } finally {
      releaseCapacity();
    }
  }

  #ensureSyntheticSettledBoundary(session: AgentSession): void {
    const sessionFile = session.sessionFile;
    if (!sessionFile || existsSync(sessionFile)) {
      return;
    }

    // Pi intentionally delays creating a JSONL file until an assistant message
    // exists. This no-model experiment executes extension commands only, so it
    // adds one explicit zero-token settled marker per new session. A real LLM
    // turn supplies the assistant message naturally and must not use this marker.
    const settledMarker = {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "[AgentDock embedded rehydrate spike: synthetic settled boundary]",
        },
      ],
      api: "agent-dock-spike",
      provider: "agent-dock",
      model: "no-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    session.agent.state.messages.push(settledMarker);
    session.sessionManager.appendMessage(settledMarker);
  }

  #resolveSessionFile(input: ExecuteEmbeddedCommand): string | undefined {
    const cached = this.#sessionFiles.get(input.logicalSessionId);
    const supplied = input.checkpoint
      ? assertOwnedCheckpoint(this.#sessionDir, input.checkpoint.sessionFile)
      : undefined;
    if (cached && supplied && cached !== supplied) {
      throw new Error(`Logical session ${input.logicalSessionId} was given a conflicting checkpoint`);
    }
    const selected = cached ?? supplied;
    if (selected) {
      const owner = this.#checkpointOwners.get(selected);
      if (owner && owner !== input.logicalSessionId) {
        throw new Error(`Checkpoint is already owned by logical session ${owner}`);
      }
      this.#sessionFiles.set(input.logicalSessionId, selected);
      this.#checkpointOwners.set(selected, input.logicalSessionId);
    }
    return selected;
  }

  #rememberCheckpoint(logicalSessionId: string, sessionFile: string): void {
    const owner = this.#checkpointOwners.get(sessionFile);
    if (owner && owner !== logicalSessionId) {
      throw new Error(`Checkpoint is already owned by logical session ${owner}`);
    }
    this.#sessionFiles.set(logicalSessionId, sessionFile);
    this.#checkpointOwners.set(sessionFile, logicalSessionId);
  }

  #inSessionLane<T>(logicalSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionTails.get(logicalSessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionTails.set(logicalSessionId, settled);

    const cleanup = (): void => {
      if (this.#sessionTails.get(logicalSessionId) === settled) {
        this.#sessionTails.delete(logicalSessionId);
      }
    };
    return result.then(
      (value) => {
        cleanup();
        return value;
      },
      (error: unknown) => {
        cleanup();
        throw error;
      },
    );
  }
}
