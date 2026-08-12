import type { Database } from "@agent-dock/database";
import {
  TEMPORAL_RUN_WORKFLOW,
  temporalRunPriority,
  temporalRunWorkflowId,
  type TemporalRunWorkflowInput,
} from "@agent-dock/temporal-orchestration";
import { TURN_CANCELLATION_OUTBOX_TOPIC, TURN_COMMAND_OUTBOX_TOPIC } from "@agent-dock/protocol";
import { Client, Connection } from "@temporalio/client";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { PostgresTemporalWorkerAffinity } from "@agent-dock/runtime-core/temporal-worker-affinity";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAXIMUM_CONCURRENT_HANDOFFS = 16;

type ExecuteReference = TemporalRunWorkflowInput & { outboxId: string };

type CancellationReference = {
  outboxId: string;
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
  pollIntervalMs?: number;
  batchSize?: number;
  maximumConcurrentHandoffs?: number;
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

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!signal.aborted) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        await operation(values[index]!);
      }
    }),
  );
}

export async function listPendingTemporalRunExecutions(
  database: Kysely<Database>,
  batchSize: number,
): Promise<ExecuteReference[]> {
  return database
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
    .innerJoin("sessions as session", (join) =>
      join
        .onRef("session.tenant_id", "=", "command.tenant_id")
        .onRef("session.id", "=", "command.session_id"),
    )
    .innerJoin("workspaces as workspace", (join) =>
      join
        .onRef("workspace.tenant_id", "=", "session.tenant_id")
        .onRef("workspace.id", "=", "session.workspace_id"),
    )
    .innerJoin("execution_cells as cell", "cell.id", "workspace.cell_id")
    .select([
      "outbox.id as outboxId",
      "cell.id as cellId",
      "cell.temporal_task_queue as taskQueue",
      "command.tenant_id as tenantId",
      "command.session_id as sessionId",
      "command.id as commandId",
      "run.id as runId",
    ])
    .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
    .where("outbox.temporal_handed_off_at", "is", null)
    .where("command.kind", "=", "turn.execute")
    .where("command.state", "in", ["pending", "dispatched"])
    .orderBy("outbox.created_at", "asc")
    .limit(positiveInteger(batchSize, "batchSize"))
    .execute()
    .then((rows) => rows.map((row) => ({ schemaVersion: 2 as const, ...row })));
}

/**
 * Transactional-outbox relay only. It starts or cancels one deterministic
 * Temporal Workflow per accepted Run; it never selects a Pi Worker.
 */
export class TemporalRunOrchestrator {
  readonly #database: Kysely<Database>;
  readonly #address: string;
  readonly #namespace: string;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #maximumConcurrentHandoffs: number;
  readonly #onActivity: ((activity: TemporalRunOrchestratorActivity) => void) | undefined;
  readonly #workerAffinity: PostgresTemporalWorkerAffinity;
  #state: TemporalRunOrchestratorState = "idle";
  #connection: Connection | undefined;
  #client: Client | undefined;
  #controller: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(options: TemporalRunOrchestratorOptions) {
    this.#database = options.database;
    this.#address = bounded(options.address, "address", 512);
    this.#namespace = bounded(options.namespace, "namespace", 255);
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
    this.#maximumConcurrentHandoffs = positiveInteger(
      options.maximumConcurrentHandoffs ?? DEFAULT_MAXIMUM_CONCURRENT_HANDOFFS,
      "maximumConcurrentHandoffs",
    );
    this.#onActivity = options.onActivity;
    this.#workerAffinity = new PostgresTemporalWorkerAffinity({
      database: this.#database,
    });
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
        await runBounded(executions, this.#maximumConcurrentHandoffs, signal, (execution) =>
          this.#ensureWorkflow(execution),
        );
        await runBounded(cancellations, this.#maximumConcurrentHandoffs, signal, (cancellation) =>
          this.#requestCancellation(cancellation),
        );
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
    return listPendingTemporalRunExecutions(this.#database, this.#batchSize);
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
      .select([
        "outbox.id as outboxId",
        "run.id as runId",
        "cancellation.id as commandId",
        "target.id as targetCommandId",
      ])
      .where("outbox.topic", "=", TURN_CANCELLATION_OUTBOX_TOPIC)
      .where("outbox.temporal_handed_off_at", "is", null)
      .where("cancellation.kind", "=", "turn.cancel")
      .where("cancellation.state", "in", ["pending", "dispatched"])
      .orderBy("outbox.created_at", "asc")
      .limit(this.#batchSize)
      .execute();
  }

  async #ensureWorkflow(input: ExecuteReference): Promise<void> {
    const workflowId = temporalRunWorkflowId(input.runId);
    try {
      const affinity = await this.#workerAffinity.reserve(input).catch(() => undefined);
      const { outboxId: _outboxId, ...workflowReference } = input;
      const workflowInput =
        affinity === undefined ? workflowReference : { ...workflowReference, affinity };
      await this.#client!.workflow.start(TEMPORAL_RUN_WORKFLOW, {
        workflowId,
        taskQueue: input.taskQueue,
        args: [workflowInput],
        workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
        workflowIdConflictPolicy: "USE_EXISTING",
        workflowExecutionTimeout: "7 days",
        workflowRunTimeout: "24 hours",
        priority: temporalRunPriority(input),
        staticSummary: "Execute one accepted AgentDock Run",
      });
      await this.#markTemporalHandoff(input.outboxId);
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
    const workflowId = temporalRunWorkflowId(input.runId);
    try {
      await this.#client!.workflow.getHandle(workflowId).cancel();
      await this.#markTemporalHandoff(input.outboxId);
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

  async #markTemporalHandoff(outboxId: string): Promise<void> {
    const update = await this.#database
      .updateTable("outbox")
      .set({ temporal_handed_off_at: new Date(), last_error: null })
      .where("id", "=", outboxId)
      .where("temporal_handed_off_at", "is", null)
      .executeTakeFirst();
    if (update.numUpdatedRows === 1n) return;
    const existing = await this.#database
      .selectFrom("outbox")
      .select("temporal_handed_off_at")
      .where("id", "=", outboxId)
      .executeTakeFirst();
    if (existing?.temporal_handed_off_at === null || existing === undefined) {
      throw new Error("Temporal handoff Outbox row could not be committed");
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
