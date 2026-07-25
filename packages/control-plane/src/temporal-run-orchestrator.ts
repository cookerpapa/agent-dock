import type { Database } from "@agent-dock/database";
import {
  TEMPORAL_RUN_WORKFLOW,
  temporalRunWorkflowId,
  type TemporalRunWorkflowInput,
} from "@agent-dock/temporal-orchestration";
import { TURN_CANCELLATION_OUTBOX_TOPIC, TURN_COMMAND_OUTBOX_TOPIC } from "@agent-dock/protocol";
import { Client, Connection } from "@temporalio/client";
import type { Kysely } from "kysely";
import { sql } from "kysely";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_BATCH_SIZE = 100;
const RECONCILIATION_INTERVAL_MS = 60_000;
const CANCELLATION_RETRY_INTERVAL_MS = 1_000;

type ExecuteReference = TemporalRunWorkflowInput;

type CancellationReference = {
  runId: string;
  commandId: string;
  targetCommandId: string;
};

export type TemporalRunOrchestratorActivity =
  | {
      type: "workflow.started";
      workflowId: string;
      runId: string;
      commandId: string;
    }
  | {
      type: "workflow.cancel_requested";
      workflowId: string;
      runId: string;
      commandId: string;
    }
  | {
      type: "orchestrator.failure";
      operation: "scan" | "start" | "cancel";
      code: string;
    };

export type TemporalRunOrchestratorOptions = {
  database: Kysely<Database>;
  address: string;
  namespace: string;
  taskQueue: string;
  pollIntervalMs?: number;
  batchSize?: number;
  onActivity?: (activity: TemporalRunOrchestratorActivity) => void;
};

export type TemporalRunOrchestratorState = "idle" | "starting" | "running" | "stopping" | "stopped";

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

function safeFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
  ) {
    return error.name.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }
  return "temporal_orchestration_failed";
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    timer.unref();
    const onAbort = (): void => settle();
    function settle(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Transactional-outbox relay only. It starts or cancels one deterministic
 * Temporal Workflow per accepted Run; it never selects a Pi Worker.
 */
export class TemporalRunOrchestrator {
  readonly #database: Kysely<Database>;
  readonly #address: string;
  readonly #namespace: string;
  readonly #taskQueue: string;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #onActivity: ((activity: TemporalRunOrchestratorActivity) => void) | undefined;
  readonly #started = new Map<string, number>();
  readonly #cancelled = new Map<string, number>();
  #state: TemporalRunOrchestratorState = "idle";
  #connection: Connection | undefined;
  #client: Client | undefined;
  #controller: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(options: TemporalRunOrchestratorOptions) {
    this.#database = options.database;
    this.#address = bounded(options.address, "address", 512);
    this.#namespace = bounded(options.namespace, "namespace", 255);
    this.#taskQueue = bounded(options.taskQueue, "taskQueue", 255);
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
    this.#onActivity = options.onActivity;
  }

  get state(): TemporalRunOrchestratorState {
    return this.#state;
  }

  async checkHealth(): Promise<void> {
    if (this.#state !== "running" || this.#connection === undefined) {
      throw new Error("Temporal Run orchestrator is not running");
    }
    await this.#connection.workflowService.getSystemInfo({});
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("Temporal Run orchestrator can only start once");
    this.#state = "starting";
    try {
      this.#connection = await Connection.connect({ address: this.#address });
      this.#client = new Client({
        connection: this.#connection,
        namespace: this.#namespace,
      });
      this.#controller = new AbortController();
      this.#state = "running";
      this.#loop = this.#run(this.#controller.signal);
    } catch (error: unknown) {
      this.#state = "stopped";
      await this.#connection?.close().catch(() => undefined);
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
    this.#controller?.abort();
    await this.#loop;
    await this.#connection?.close().catch(() => undefined);
    this.#state = "stopped";
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const [executions, cancellations] = await Promise.all([
          this.#executionReferences(),
          this.#cancellationReferences(),
        ]);
        for (const execution of executions) {
          if (signal.aborted) return;
          await this.#ensureWorkflow(execution);
        }
        for (const cancellation of cancellations) {
          if (signal.aborted) return;
          await this.#requestCancellation(cancellation);
        }
        this.#prune();
      } catch (error: unknown) {
        this.#observe({
          type: "orchestrator.failure",
          operation: "scan",
          code: safeFailureCode(error),
        });
      }
      await wait(this.#pollIntervalMs, signal);
    }
  }

  async #executionReferences(): Promise<ExecuteReference[]> {
    return this.#database
      .selectFrom("outbox")
      .innerJoin("commands as command", (join) =>
        join
          .onRef("command.tenant_id", "=", "outbox.tenant_id")
          .on(
            sql<boolean>`${sql.ref("command.id")}::text = ${sql.ref("outbox.payload")} ->> 'commandId'`,
          ),
      )
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "command.tenant_id")
          .onRef("run.command_id", "=", "command.id"),
      )
      .select([
        "command.tenant_id as tenantId",
        "command.session_id as sessionId",
        "command.id as commandId",
        "run.id as runId",
      ])
      .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
      .where("outbox.published_at", "is", null)
      .where("command.kind", "=", "turn.execute")
      .where("command.state", "in", ["pending", "dispatched"])
      .orderBy("outbox.created_at", "asc")
      .limit(this.#batchSize)
      .execute()
      .then((rows) => rows.map((row) => ({ schemaVersion: 1 as const, ...row })));
  }

  async #cancellationReferences(): Promise<CancellationReference[]> {
    return this.#database
      .selectFrom("outbox")
      .innerJoin("commands as cancellation", (join) =>
        join
          .onRef("cancellation.tenant_id", "=", "outbox.tenant_id")
          .on(
            sql<boolean>`${sql.ref("cancellation.id")}::text = ${sql.ref("outbox.payload")} ->> 'commandId'`,
          ),
      )
      .innerJoin("commands as target", (join) =>
        join
          .onRef("target.tenant_id", "=", "cancellation.tenant_id")
          .on(
            sql<boolean>`${sql.ref("target.id")}::text = ${sql.ref("outbox.payload")} ->> 'targetCommandId'`,
          ),
      )
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "target.tenant_id")
          .onRef("run.command_id", "=", "target.id"),
      )
      .select(["run.id as runId", "cancellation.id as commandId", "target.id as targetCommandId"])
      .where("outbox.topic", "=", TURN_CANCELLATION_OUTBOX_TOPIC)
      .where("outbox.published_at", "is", null)
      .where("cancellation.kind", "=", "turn.cancel")
      .where("cancellation.state", "in", ["pending", "dispatched"])
      .orderBy("outbox.created_at", "asc")
      .limit(this.#batchSize)
      .execute();
  }

  async #ensureWorkflow(input: ExecuteReference): Promise<void> {
    const observed = this.#started.get(input.commandId);
    if (observed !== undefined && Date.now() - observed < RECONCILIATION_INTERVAL_MS) return;
    const workflowId = temporalRunWorkflowId(input.runId);
    try {
      await this.#client!.workflow.start(TEMPORAL_RUN_WORKFLOW, {
        workflowId,
        taskQueue: this.#taskQueue,
        args: [input],
        workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
        workflowIdConflictPolicy: "USE_EXISTING",
        workflowExecutionTimeout: "7 days",
        workflowRunTimeout: "24 hours",
        priority: {
          priorityKey: 3,
          fairnessKey: input.tenantId,
          fairnessWeight: 1,
        },
        staticSummary: "Execute one accepted AgentDock Run",
      });
      this.#started.set(input.commandId, Date.now());
      this.#observe({
        type: "workflow.started",
        workflowId,
        runId: input.runId,
        commandId: input.commandId,
      });
    } catch (error: unknown) {
      this.#observe({
        type: "orchestrator.failure",
        operation: "start",
        code: safeFailureCode(error),
      });
    }
  }

  async #requestCancellation(input: CancellationReference): Promise<void> {
    const observed = this.#cancelled.get(input.commandId);
    if (observed !== undefined && Date.now() - observed < CANCELLATION_RETRY_INTERVAL_MS) return;
    const workflowId = temporalRunWorkflowId(input.runId);
    try {
      await this.#client!.workflow.getHandle(workflowId).cancel();
      this.#cancelled.set(input.commandId, Date.now());
      this.#observe({
        type: "workflow.cancel_requested",
        workflowId,
        runId: input.runId,
        commandId: input.commandId,
      });
    } catch (error: unknown) {
      this.#observe({
        type: "orchestrator.failure",
        operation: "cancel",
        code: safeFailureCode(error),
      });
    }
  }

  #prune(): void {
    const cutoff = Date.now() - RECONCILIATION_INTERVAL_MS;
    for (const [key, observedAt] of this.#started) {
      if (observedAt < cutoff) this.#started.delete(key);
    }
    for (const [key, observedAt] of this.#cancelled) {
      if (observedAt < cutoff) this.#cancelled.delete(key);
    }
  }

  #observe(activity: TemporalRunOrchestratorActivity): void {
    try {
      this.#onActivity?.(activity);
    } catch {
      // Observability is not part of the orchestration correctness path.
    }
  }
}
