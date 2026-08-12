import {
  type RunCancellationExecutionResult,
  RunCancellationExecutor,
} from "@agent-dock/runtime-core/run-cancellation-executor";
import {
  type RunCommandExecutionResult,
  RunCommandExecutor,
} from "@agent-dock/runtime-core/run-command-executor";
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

const DEFAULT_DEFERRED_RETRY_MS = 1_000;
const CANCELLATION_DISCOVERY_ATTEMPTS = 20;
const CANCELLATION_DISCOVERY_DELAY_MS = 50;

export type TemporalPiWorkerOptions = {
  database: Kysely<Database>;
  address: string;
  namespace: string;
  cellId: string;
  taskQueue: string;
  identity: string;
  maximumConcurrentRuns: number;
  shutdownGraceMs: number;
  workerDeployment?: {
    deploymentName: string;
    buildId: string;
  };
  commandExecutor: RunCommandExecutor;
  cancellationExecutor: RunCancellationExecutor;
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
  readonly #cellId: string;
  readonly #taskQueue: string;
  readonly #identity: string;
  readonly #maximumConcurrentRuns: number;
  readonly #shutdownGraceMs: number;
  readonly #workerDeployment:
    | {
        deploymentName: string;
        buildId: string;
      }
    | undefined;
  readonly #commandExecutor: RunCommandExecutor;
  readonly #cancellationExecutor: RunCancellationExecutor;
  #state: TemporalPiWorkerState = "idle";
  #connection: NativeConnection | undefined;
  #sharedWorker: Worker | undefined;
  #run: Promise<void> | undefined;

  constructor(options: TemporalPiWorkerOptions) {
    this.#database = options.database;
    this.#address = bounded(options.address, "address", 512);
    this.#namespace = bounded(options.namespace, "namespace", 255);
    this.#cellId = bounded(options.cellId, "cellId", 64);
    this.#taskQueue = bounded(options.taskQueue, "taskQueue", 255);
    this.#identity = bounded(options.identity, "identity", 255);
    this.#maximumConcurrentRuns = positiveInteger(
      options.maximumConcurrentRuns,
      "maximumConcurrentRuns",
    );
    this.#shutdownGraceMs = positiveInteger(options.shutdownGraceMs, "shutdownGraceMs");
    this.#workerDeployment =
      options.workerDeployment === undefined
        ? undefined
        : {
            deploymentName: bounded(
              options.workerDeployment.deploymentName,
              "workerDeployment.deploymentName",
              127,
            ),
            buildId: bounded(options.workerDeployment.buildId, "workerDeployment.buildId", 255),
          };
    this.#commandExecutor = options.commandExecutor;
    this.#cancellationExecutor = options.cancellationExecutor;
  }

  get state(): TemporalPiWorkerState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("Temporal Pi Worker can only start once");
    this.#state = "starting";
    try {
      this.#connection = await NativeConnection.connect({ address: this.#address });
      const versioningOptions =
        this.#workerDeployment === undefined
          ? {}
          : {
              workerDeploymentOptions: {
                version: this.#workerDeployment,
                useWorkerVersioning: true as const,
                defaultVersioningBehavior: "PINNED" as const,
              },
            };
      this.#sharedWorker = await Worker.create({
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
        ...versioningOptions,
        maxConcurrentActivityTaskExecutions: this.#maximumConcurrentRuns,
        maxConcurrentWorkflowTaskExecutions: Math.max(8, this.#maximumConcurrentRuns * 4),
        shutdownGraceTime: this.#shutdownGraceMs,
      });
      this.#state = "running";
      this.#run = this.#sharedWorker.run().finally(() => {
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
    this.#sharedWorker?.shutdown();
    await this.#run;
    await this.#connection?.close().catch(() => undefined);
    this.#state = "stopped";
  }

  async #execute(rawInput: TemporalRunWorkflowInput): Promise<TemporalRunActivityResult> {
    const input = validateTemporalRunWorkflowInput(rawInput);
    if (input.cellId !== this.#cellId || input.taskQueue !== this.#taskQueue) {
      throw new TypeError("Temporal Run was routed to the wrong execution Cell");
    }
    const context = Context.current();
    let cancellation: Promise<RunCancellationExecutionResult> | undefined;
    const beginCancellation = (): void => {
      cancellation ??= this.#cancelTarget(input.commandId);
    };
    context.cancellationSignal.addEventListener("abort", beginCancellation, { once: true });
    heartbeat({
      schemaVersion: 1,
      cellId: input.cellId,
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
      const result = await this.#commandExecutor.dispatchCommand(input.commandId);
      if (context.cancellationSignal.aborted) {
        beginCancellation();
        await cancellation;
      }
      const activityResult = await this.#activityResult(input, result);
      return activityResult;
    } finally {
      clearInterval(heartbeatTimer);
      context.cancellationSignal.removeEventListener("abort", beginCancellation);
    }
  }

  async #cancelTarget(targetCommandId: string): Promise<RunCancellationExecutionResult> {
    for (let attempt = 0; attempt < CANCELLATION_DISCOVERY_ATTEMPTS; attempt += 1) {
      const result = await this.#cancellationExecutor.dispatchTargetCommand(targetCommandId);
      if (result.status !== "idle") return result;
      await delay(CANCELLATION_DISCOVERY_DELAY_MS);
    }
    return { status: "idle" };
  }

  async #activityResult(
    input: TemporalRunWorkflowInput,
    result: RunCommandExecutionResult,
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
