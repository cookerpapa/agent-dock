import type { Database } from "@pi-cloud/database";
import {
  type RunCancellationExecutionResult,
  RunCancellationExecutor,
} from "@pi-cloud/runtime-core/run-cancellation-executor";
import {
  type RunCommandExecutionResult,
  RunCommandExecutor,
} from "@pi-cloud/runtime-core/run-command-executor";
import { TURN_CANCELLATION_OUTBOX_TOPIC, TURN_COMMAND_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { Client } from "pg";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SCAN_MULTIPLIER = 4;

type ExecutionReference = {
  commandId: string;
};

type CancellationReference = {
  targetCommandId: string;
};

export type PostgresPiWorkerOptions = {
  database: Kysely<Database>;
  notificationConnectionString: string;
  identity: string;
  maximumConcurrentRuns: number;
  pollIntervalMs?: number;
  commandExecutor: RunCommandExecutor;
  cancellationExecutor: RunCancellationExecutor;
  onFailure?: (operation: "listen" | "scan" | "execute" | "cancel", error: unknown) => void;
};

export type PostgresPiWorkerState = "idle" | "starting" | "running" | "stopping" | "stopped";

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

/**
 * A bounded, horizontally scalable PostgreSQL-backed Pi Worker.
 *
 * PostgreSQL owns the queue and the exact Run/Attempt lifecycle. LISTEN/NOTIFY
 * only removes idle polling latency; every wake-up is followed by a fresh
 * authoritative query. RunCommandExecutor remains the transactional claimant,
 * so duplicate notifications and competing Workers are harmless.
 */
export class PostgresPiWorker {
  readonly #database: Kysely<Database>;
  readonly #notificationConnectionString: string;
  readonly #identity: string;
  readonly #maximumConcurrentRuns: number;
  readonly #pollIntervalMs: number;
  readonly #commandExecutor: RunCommandExecutor;
  readonly #cancellationExecutor: RunCancellationExecutor;
  readonly #onFailure:
    ((operation: "listen" | "scan" | "execute" | "cancel", error: unknown) => void) | undefined;
  readonly #activeCommands = new Map<string, Promise<void>>();
  #state: PostgresPiWorkerState = "idle";
  #controller: AbortController | undefined;
  #listener: Client | undefined;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: PostgresPiWorkerOptions) {
    this.#database = options.database;
    this.#notificationConnectionString = bounded(
      options.notificationConnectionString,
      "notificationConnectionString",
      8_192,
    );
    this.#identity = bounded(options.identity, "identity", 256);
    this.#maximumConcurrentRuns = positiveInteger(
      options.maximumConcurrentRuns,
      "maximumConcurrentRuns",
    );
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#commandExecutor = options.commandExecutor;
    this.#cancellationExecutor = options.cancellationExecutor;
    this.#onFailure = options.onFailure;
  }

  get state(): PostgresPiWorkerState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("PostgreSQL Pi Worker can only start once");
    this.#state = "starting";
    this.#controller = new AbortController();
    try {
      await this.#startListener();
      this.#state = "running";
      this.#loop = this.#run(this.#controller.signal).finally(() => {
        if (this.#state !== "stopping") this.#state = "stopped";
      });
    } catch (error: unknown) {
      this.#state = "stopped";
      await this.#listener?.end().catch(() => undefined);
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
    this.#wake?.();
    await this.#loop;
    await Promise.allSettled(this.#activeCommands.values());
    await this.#listener?.end().catch(() => undefined);
    this.#state = "stopped";
  }

  async #startListener(): Promise<void> {
    const listener = new Client({
      connectionString: this.#notificationConnectionString,
      application_name: `${this.#identity}-run-queue`,
    });
    listener.on("notification", (message) => {
      if (message.channel === "pi_cloud_run_queue") this.#wake?.();
    });
    listener.on("error", (error) => this.#observeFailure("listen", error));
    await listener.connect();
    await listener.query("listen pi_cloud_run_queue");
    this.#listener = listener;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.#dispatchCancellations();
        await this.#fillCapacity();
      } catch (error: unknown) {
        this.#observeFailure("scan", error);
      }
      await this.#waitForWake(signal);
    }
  }

  async #fillCapacity(): Promise<void> {
    const available = this.#maximumConcurrentRuns - this.#activeCommands.size;
    if (available < 1) return;
    const references = await this.#executionReferences(
      Math.max(available, available * DEFAULT_SCAN_MULTIPLIER),
    );
    for (const reference of references) {
      if (this.#activeCommands.size >= this.#maximumConcurrentRuns) return;
      if (this.#activeCommands.has(reference.commandId)) continue;
      const execution = this.#execute(reference).finally(() => {
        this.#activeCommands.delete(reference.commandId);
        this.#wake?.();
      });
      this.#activeCommands.set(reference.commandId, execution);
    }
  }

  async #dispatchCancellations(): Promise<void> {
    if (this.#activeCommands.size === 0) return;
    const references = await this.#cancellationReferences();
    await Promise.all(
      references.map(async (reference) => {
        try {
          await this.#cancellationExecutor.dispatchTargetCommand(reference.targetCommandId);
        } catch (error: unknown) {
          this.#observeFailure("cancel", error);
        }
      }),
    );
  }

  async #execute(reference: ExecutionReference): Promise<void> {
    try {
      const result = await this.#commandExecutor.dispatchCommand(reference.commandId);
      await this.#settleDispatchResult(result);
    } catch (error: unknown) {
      this.#observeFailure("execute", error);
    }
  }

  async #settleDispatchResult(_result: RunCommandExecutionResult): Promise<void> {
    // RunCommandExecutor owns every durable transition. The queue only needs
    // another scan: completed work is published, while a deferred/retryable
    // record carries its next available_at timestamp.
  }

  async #executionReferences(limit: number): Promise<ExecutionReference[]> {
    const now = new Date();
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
      .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "command.tenant_id")
      .select("command.id as commandId")
      .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
      .where("outbox.published_at", "is", null)
      .where("outbox.available_at", "<=", now)
      .where("command.kind", "=", "turn.execute")
      .where("command.state", "in", ["pending", "dispatched"])
      .where("run.state", "in", ["queued", "claimed"])
      .where("policy.enabled", "=", true)
      .orderBy("policy.last_scheduled_at", "asc")
      .orderBy("outbox.available_at", "asc")
      .orderBy("outbox.created_at", "asc")
      .limit(positiveInteger(limit, "limit"))
      .execute();
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
      .innerJoin("run_attempts as attempt", (join) =>
        join
          .onRef("attempt.run_id", "=", "run.id")
          .onRef("attempt.id", "=", "run.current_attempt_id"),
      )
      .select("target.id as targetCommandId")
      .where("outbox.topic", "=", TURN_CANCELLATION_OUTBOX_TOPIC)
      .where("outbox.published_at", "is", null)
      .where("outbox.available_at", "<=", new Date())
      .where("cancellation.kind", "=", "turn.cancel")
      .where("cancellation.state", "in", ["pending", "dispatched"])
      .where("attempt.claim_owner_id", "=", this.#identity)
      .where("attempt.state", "in", ["provisioning", "restoring", "running", "checkpointing"])
      .limit(this.#maximumConcurrentRuns)
      .execute();
  }

  #waitForWake(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolvePromise) => {
      let settled = false;
      const timer = setTimeout(settle, this.#pollIntervalMs);
      timer.unref();
      const onAbort = (): void => settle();
      const wake = (): void => settle();
      this.#wake = wake;
      function settle(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }).finally(() => {
      this.#wake = undefined;
    });
  }

  #observeFailure(operation: "listen" | "scan" | "execute" | "cancel", error: unknown): void {
    try {
      this.#onFailure?.(operation, error);
    } catch {
      // Observability cannot become queue authority.
    }
  }
}

export type { RunCancellationExecutionResult };
