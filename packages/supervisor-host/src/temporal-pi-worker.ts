import {
  type CancellationDispatchNextResult,
  CancellationDispatcher,
} from "@agent-dock/control-plane/cancellation-dispatcher";
import {
  type DispatchNextResult,
  OutboxDispatcher,
} from "@agent-dock/control-plane/outbox-dispatcher";
import type { Database } from "@agent-dock/database";
import {
  type TemporalRunActivityResult,
  type TemporalRunWorkflowInput,
  validateTemporalRunWorkflowInput,
} from "@agent-dock/temporal-orchestration";
import { Context, heartbeat } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { Kysely } from "kysely";
import { fileURLToPath } from "node:url";

const DEFAULT_DEFERRED_RETRY_MS = 250;
const CANCELLATION_DISCOVERY_ATTEMPTS = 20;
const CANCELLATION_DISCOVERY_DELAY_MS = 50;

export type TemporalPiWorkerOptions = {
  database: Kysely<Database>;
  address: string;
  namespace: string;
  taskQueue: string;
  identity: string;
  maximumConcurrentRuns: number;
  executionDispatcher: OutboxDispatcher;
  cancellationDispatcher: CancellationDispatcher;
};

export type TemporalPiWorkerState = "idle" | "starting" | "running" | "stopping" | "stopped";

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function bounded(value: string, name: string, maximum: number): string {
  if (value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, durationMs);
  });
}

export class TemporalPiWorker {
  readonly #database: Kysely<Database>;
  readonly #address: string;
  readonly #namespace: string;
  readonly #taskQueue: string;
  readonly #identity: string;
  readonly #maximumConcurrentRuns: number;
  readonly #executionDispatcher: OutboxDispatcher;
  readonly #cancellationDispatcher: CancellationDispatcher;
  #state: TemporalPiWorkerState = "idle";
  #connection: NativeConnection | undefined;
  #worker: Worker | undefined;
  #run: Promise<void> | undefined;

  constructor(options: TemporalPiWorkerOptions) {
    this.#database = options.database;
    this.#address = bounded(options.address, "address", 512);
    this.#namespace = bounded(options.namespace, "namespace", 255);
    this.#taskQueue = bounded(options.taskQueue, "taskQueue", 255);
    this.#identity = bounded(options.identity, "identity", 255);
    this.#maximumConcurrentRuns = positiveInteger(
      options.maximumConcurrentRuns,
      "maximumConcurrentRuns",
    );
    this.#executionDispatcher = options.executionDispatcher;
    this.#cancellationDispatcher = options.cancellationDispatcher;
  }

  get state(): TemporalPiWorkerState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("Temporal Pi Worker can only start once");
    this.#state = "starting";
    try {
      this.#connection = await NativeConnection.connect({ address: this.#address });
      this.#worker = await Worker.create({
        connection: this.#connection,
        namespace: this.#namespace,
        taskQueue: this.#taskQueue,
        workflowsPath: fileURLToPath(
          import.meta.resolve("@agent-dock/temporal-orchestration/workflows"),
        ),
        activities: {
          executeRunCommand: (input: TemporalRunWorkflowInput) => this.#execute(input),
        },
        identity: this.#identity,
        maxConcurrentActivityTaskExecutions: this.#maximumConcurrentRuns,
        maxConcurrentWorkflowTaskExecutions: Math.max(8, this.#maximumConcurrentRuns * 4),
        shutdownGraceTime: "30 seconds",
      });
      this.#state = "running";
      this.#run = this.#worker.run().finally(() => {
        if (this.#state !== "stopping") this.#state = "stopped";
      });
    } catch (error: unknown) {
      await this.#connection?.close().catch(() => undefined);
      this.#state = "stopped";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    this.#worker?.shutdown();
    await this.#run;
    await this.#connection?.close().catch(() => undefined);
    this.#state = "stopped";
  }

  async #execute(rawInput: TemporalRunWorkflowInput): Promise<TemporalRunActivityResult> {
    const input = validateTemporalRunWorkflowInput(rawInput);
    const context = Context.current();
    let cancellation: Promise<CancellationDispatchNextResult> | undefined;
    const beginCancellation = (): void => {
      cancellation ??= this.#cancelTarget(input.commandId);
    };
    context.cancellationSignal.addEventListener("abort", beginCancellation, { once: true });
    heartbeat({
      schemaVersion: 1,
      runId: input.runId,
      commandId: input.commandId,
    });
    const heartbeatTimer = setInterval(() => {
      heartbeat({
        schemaVersion: 1,
        runId: input.runId,
        commandId: input.commandId,
      });
    }, 5_000);
    heartbeatTimer.unref();

    try {
      const result = await this.#executionDispatcher.dispatchCommand(input.commandId);
      if (context.cancellationSignal.aborted) {
        beginCancellation();
        await cancellation;
      }
      return this.#activityResult(input, result);
    } finally {
      clearInterval(heartbeatTimer);
      context.cancellationSignal.removeEventListener("abort", beginCancellation);
    }
  }

  async #cancelTarget(targetCommandId: string): Promise<CancellationDispatchNextResult> {
    for (let attempt = 0; attempt < CANCELLATION_DISCOVERY_ATTEMPTS; attempt += 1) {
      const result = await this.#cancellationDispatcher.dispatchTargetCommand(targetCommandId);
      if (result.status !== "idle") return result;
      await delay(CANCELLATION_DISCOVERY_DELAY_MS);
    }
    return { status: "idle" };
  }

  async #activityResult(
    input: TemporalRunWorkflowInput,
    result: DispatchNextResult,
  ): Promise<TemporalRunActivityResult> {
    if (result.status === "completed") {
      return {
        status: "completed",
        runId: input.runId,
        commandId: input.commandId,
        attempt: result.attempt,
      };
    }
    if (result.status === "cancelled" || result.status === "cancellation_pending") {
      const run = await this.#runState(input);
      if (run.state === "cancelled") {
        return {
          status: "cancelled",
          runId: input.runId,
          commandId: input.commandId,
          attempt: result.attempt,
        };
      }
      return {
        status: "deferred",
        runId: input.runId,
        commandId: input.commandId,
        retryAfterMs: DEFAULT_DEFERRED_RETRY_MS,
      };
    }
    if (result.status === "failed") {
      return {
        status: "failed",
        runId: input.runId,
        commandId: input.commandId,
        attempt: result.attempt,
        failureCode: result.failureCode,
      };
    }
    if (result.status === "retry_scheduled") {
      return {
        status: "deferred",
        runId: input.runId,
        commandId: input.commandId,
        retryAfterMs: 1_000,
      };
    }

    const run = await this.#runState(input);
    if (run.state === "completed") {
      return {
        status: "completed",
        runId: input.runId,
        commandId: input.commandId,
        attempt: run.attemptCount,
      };
    }
    if (run.state === "cancelled") {
      return {
        status: "cancelled",
        runId: input.runId,
        commandId: input.commandId,
        attempt: run.attemptCount,
      };
    }
    if (["failed", "timed_out", "superseded"].includes(run.state)) {
      return {
        status: "failed",
        runId: input.runId,
        commandId: input.commandId,
        attempt: run.attemptCount,
        failureCode: run.failureCode ?? run.state,
      };
    }
    return {
      status: "deferred",
      runId: input.runId,
      commandId: input.commandId,
      retryAfterMs: DEFAULT_DEFERRED_RETRY_MS,
    };
  }

  async #runState(input: TemporalRunWorkflowInput): Promise<{
    state: string;
    attemptCount: number;
    failureCode: string | null;
  }> {
    const row = await this.#database
      .selectFrom("runs")
      .select(["state", "attempt_count as attemptCount", "failure_code as failureCode"])
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .where("id", "=", input.runId)
      .where("command_id", "=", input.commandId)
      .executeTakeFirstOrThrow();
    return {
      state: row.state,
      attemptCount: row.attemptCount,
      failureCode: row.failureCode,
    };
  }
}
