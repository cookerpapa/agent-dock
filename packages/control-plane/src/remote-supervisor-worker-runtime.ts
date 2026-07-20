import type { Database } from "@agent-dock/database";
import type { AgentDockMetrics } from "@agent-dock/observability";
import type { Kysely } from "kysely";

import { CancellationDispatcher } from "./cancellation-dispatcher.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import type { SupervisorMaintenanceCycleResult } from "./supervisor-connection-manager.ts";
import type { RemoteSupervisorDispatchBinding } from "./supervisor-websocket-gateway.ts";

const DEFAULT_BINDING_DISCOVERY_INTERVAL_MS = 250;
const DEFAULT_IDLE_POLL_MS = 100;
const DEFAULT_FAILURE_POLL_MS = 1_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 1_000;
const DEFAULT_MAX_LANES_PER_CONNECTION = 32;
const DEFAULT_MAINTENANCE_CONNECTION_LIMIT = 100;
const DEFAULT_MAINTENANCE_RETIREMENT_LIMIT = 10;

export interface RemoteSupervisorDispatchBindingSource {
  listRemoteDispatchBindings(): Promise<readonly RemoteSupervisorDispatchBinding[]>;
}

export interface SupervisorMaintenanceRunner {
  runMaintenanceCycle(options?: {
    connectionLimit?: number;
    retirementLimit?: number;
  }): Promise<SupervisorMaintenanceCycleResult>;
}

export type RemoteSupervisorWorkerActivity =
  | {
      type: "binding.started" | "binding.stopped";
      sandboxId: string;
      connectionId: string;
      executionLanes: number;
      cancellationLanes: number;
    }
  | {
      type: "dispatch.completed";
      kind: "execute" | "cancel";
      sandboxId: string;
      connectionId: string;
      status: string;
    }
  | {
      type: "maintenance.completed";
      scannedConnections: number;
      expiredConnections: number;
      retirements: number;
    }
  | {
      type: "runtime.failure";
      component: "binding_discovery" | "execute" | "cancel" | "maintenance";
      code: string;
      retryable: boolean;
      sandboxId?: string;
      connectionId?: string;
    };

export type RemoteSupervisorWorkerRuntimeOptions = {
  database: Kysely<Database>;
  bindingSource: RemoteSupervisorDispatchBindingSource;
  maintenanceRunner: SupervisorMaintenanceRunner;
  bindingDiscoveryIntervalMs?: number;
  idlePollMs?: number;
  failurePollMs?: number;
  maintenanceIntervalMs?: number;
  maxLanesPerConnection?: number;
  maintenanceConnectionLimit?: number;
  maintenanceRetirementLimit?: number;
  onActivity?: (activity: RemoteSupervisorWorkerActivity) => void;
  metrics?: AgentDockMetrics;
};

export type RemoteSupervisorWorkerRuntimeState = "idle" | "running" | "stopping" | "stopped";

type BindingWorker = {
  binding: RemoteSupervisorDispatchBinding;
  executionLanes: number;
  cancellationLanes: number;
  controller: AbortController;
  done: Promise<void>;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function safeFailure(error: unknown): { code: string; retryable: boolean } {
  if (typeof error !== "object" || error === null) {
    return { code: "runtime_dependency_failure", retryable: true };
  }
  const candidate = error as { code?: unknown; retryable?: unknown };
  const code =
    typeof candidate.code === "string" &&
    candidate.code.length <= 128 &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(candidate.code)
      ? candidate.code
      : "runtime_dependency_failure";
  return {
    code,
    retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : true,
  };
}

function abortableWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs === 0) return Promise.resolve();
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

export class RemoteSupervisorWorkerRuntime {
  readonly #database: Kysely<Database>;
  readonly #bindingSource: RemoteSupervisorDispatchBindingSource;
  readonly #maintenanceRunner: SupervisorMaintenanceRunner;
  readonly #bindingDiscoveryIntervalMs: number;
  readonly #idlePollMs: number;
  readonly #failurePollMs: number;
  readonly #maintenanceIntervalMs: number;
  readonly #maxLanesPerConnection: number;
  readonly #maintenanceConnectionLimit: number;
  readonly #maintenanceRetirementLimit: number;
  readonly #onActivity: ((activity: RemoteSupervisorWorkerActivity) => void) | undefined;
  readonly #metrics: AgentDockMetrics | undefined;
  readonly #bindings = new Map<string, BindingWorker>();
  readonly #retiringWorkers = new Set<Promise<void>>();
  #state: RemoteSupervisorWorkerRuntimeState = "idle";
  #controller: AbortController | undefined;
  #runPromise: Promise<void> | undefined;

  constructor(options: RemoteSupervisorWorkerRuntimeOptions) {
    this.#database = options.database;
    this.#bindingSource = options.bindingSource;
    this.#maintenanceRunner = options.maintenanceRunner;
    this.#bindingDiscoveryIntervalMs = positiveInteger(
      options.bindingDiscoveryIntervalMs ?? DEFAULT_BINDING_DISCOVERY_INTERVAL_MS,
      "bindingDiscoveryIntervalMs",
    );
    this.#idlePollMs = positiveInteger(options.idlePollMs ?? DEFAULT_IDLE_POLL_MS, "idlePollMs");
    this.#failurePollMs = positiveInteger(
      options.failurePollMs ?? DEFAULT_FAILURE_POLL_MS,
      "failurePollMs",
    );
    this.#maintenanceIntervalMs = positiveInteger(
      options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
      "maintenanceIntervalMs",
    );
    this.#maxLanesPerConnection = positiveInteger(
      options.maxLanesPerConnection ?? DEFAULT_MAX_LANES_PER_CONNECTION,
      "maxLanesPerConnection",
    );
    this.#maintenanceConnectionLimit = positiveInteger(
      options.maintenanceConnectionLimit ?? DEFAULT_MAINTENANCE_CONNECTION_LIMIT,
      "maintenanceConnectionLimit",
    );
    this.#maintenanceRetirementLimit = positiveInteger(
      options.maintenanceRetirementLimit ?? DEFAULT_MAINTENANCE_RETIREMENT_LIMIT,
      "maintenanceRetirementLimit",
    );
    this.#onActivity = options.onActivity;
    this.#metrics = options.metrics;
  }

  get state(): RemoteSupervisorWorkerRuntimeState {
    return this.#state;
  }

  get activeBindingCount(): number {
    return this.#bindings.size;
  }

  start(): void {
    if (this.#state !== "idle") {
      throw new Error("Remote supervisor worker runtime was already started");
    }
    this.#state = "running";
    this.#controller = new AbortController();
    const signal = this.#controller.signal;
    this.#runPromise = Promise.all([
      this.#runBindingDiscovery(signal),
      this.#runMaintenance(signal),
    ]).then(() => {
      this.#state = "stopped";
    });
  }

  beginDrain(): void {
    if (this.#state === "idle") {
      this.#state = "stopped";
      return;
    }
    if (this.#state !== "running") return;
    this.#state = "stopping";
    this.#controller?.abort();
  }

  async stop(): Promise<void> {
    this.beginDrain();
    await this.#runPromise;
  }

  async #runBindingDiscovery(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        let delayMs = this.#bindingDiscoveryIntervalMs;
        try {
          const bindings = await this.#bindingSource.listRemoteDispatchBindings();
          const queued = await this.#database
            .selectFrom("runs")
            .select((expression) => expression.fn.countAll<string>().as("count"))
            .where("state", "=", "queued")
            .executeTakeFirstOrThrow();
          this.#metrics?.queuedRuns.set(Number(queued.count));
          if (signal.aborted) break;
          this.#synchronizeBindings(bindings);
        } catch (error: unknown) {
          const failure = safeFailure(error);
          this.#observe({
            type: "runtime.failure",
            component: "binding_discovery",
            ...failure,
          });
          delayMs = this.#failurePollMs;
        }
        await abortableWait(delayMs, signal);
      }
    } finally {
      await this.#stopAllBindings();
    }
  }

  async #runMaintenance(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let delayMs = this.#maintenanceIntervalMs;
      try {
        const result = await this.#maintenanceRunner.runMaintenanceCycle({
          connectionLimit: this.#maintenanceConnectionLimit,
          retirementLimit: this.#maintenanceRetirementLimit,
        });
        this.#observe({
          type: "maintenance.completed",
          scannedConnections: result.connections.scannedConnections,
          expiredConnections: result.connections.expiredConnections,
          retirements: result.retirements.length,
        });
      } catch (error: unknown) {
        const failure = safeFailure(error);
        this.#observe({
          type: "runtime.failure",
          component: "maintenance",
          ...failure,
        });
        delayMs = this.#failurePollMs;
      }
      await abortableWait(delayMs, signal);
    }
  }

  #synchronizeBindings(bindings: readonly RemoteSupervisorDispatchBinding[]): void {
    const byConnection = new Map<string, RemoteSupervisorDispatchBinding>();
    for (const binding of bindings) {
      requireUuid(binding.connectionId, "binding.connectionId");
      requireUuid(binding.sandboxId, "binding.sandboxId");
      positiveInteger(binding.maxConcurrentSessions, "binding.maxConcurrentSessions");
      if (byConnection.has(binding.connectionId)) {
        throw new TypeError("binding source returned a duplicate connection");
      }
      byConnection.set(binding.connectionId, binding);
    }

    for (const [connectionId, worker] of this.#bindings) {
      const current = byConnection.get(connectionId);
      if (
        current === undefined ||
        current.sandboxId !== worker.binding.sandboxId ||
        current.maxConcurrentSessions !== worker.binding.maxConcurrentSessions
      ) {
        this.#retireBinding(connectionId, worker);
      }
    }
    for (const [connectionId, binding] of byConnection) {
      if (!this.#bindings.has(connectionId)) {
        this.#bindings.set(connectionId, this.#startBinding(binding));
      }
    }
  }

  #startBinding(binding: RemoteSupervisorDispatchBinding): BindingWorker {
    const controller = new AbortController();
    const laneCount = Math.min(binding.maxConcurrentSessions, this.#maxLanesPerConnection);
    const laneTasks: Promise<void>[] = [];
    for (let lane = 0; lane < laneCount; lane += 1) {
      const executionDispatcher = new OutboxDispatcher({
        database: this.#database,
        backend: binding.backend,
        leaseManager: binding.leaseCoordinator,
        supervisorAffinity: binding.supervisorAffinity,
        ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
      });
      const cancellationDispatcher = new CancellationDispatcher({
        database: this.#database,
        backend: binding.backend,
        leaseManager: binding.leaseCoordinator,
        supervisorAffinity: binding.supervisorAffinity,
      });
      laneTasks.push(
        this.#runDispatchLane(
          "execute",
          binding,
          () => executionDispatcher.dispatchNext(),
          controller.signal,
        ),
        this.#runDispatchLane(
          "cancel",
          binding,
          () => cancellationDispatcher.dispatchNext(),
          controller.signal,
        ),
      );
    }
    const worker: BindingWorker = {
      binding,
      executionLanes: laneCount,
      cancellationLanes: laneCount,
      controller,
      done: Promise.all(laneTasks).then(() => undefined),
    };
    this.#observe({
      type: "binding.started",
      sandboxId: binding.sandboxId,
      connectionId: binding.connectionId,
      executionLanes: laneCount,
      cancellationLanes: laneCount,
    });
    return worker;
  }

  async #runDispatchLane(
    kind: "execute" | "cancel",
    binding: RemoteSupervisorDispatchBinding,
    dispatchNext: () => Promise<{ status: string }>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await dispatchNext();
        if (signal.aborted) return;
        if (result.status === "idle") {
          await abortableWait(this.#idlePollMs, signal);
        } else {
          this.#observe({
            type: "dispatch.completed",
            kind,
            sandboxId: binding.sandboxId,
            connectionId: binding.connectionId,
            status: result.status,
          });
        }
      } catch (error: unknown) {
        if (signal.aborted) return;
        const failure = safeFailure(error);
        this.#observe({
          type: "runtime.failure",
          component: kind,
          sandboxId: binding.sandboxId,
          connectionId: binding.connectionId,
          ...failure,
        });
        await abortableWait(this.#failurePollMs, signal);
      }
    }
  }

  #retireBinding(connectionId: string, worker: BindingWorker): void {
    if (this.#bindings.get(connectionId) === worker) {
      this.#bindings.delete(connectionId);
    }
    worker.controller.abort();
    let retiring!: Promise<void>;
    retiring = worker.done.finally(() => {
      this.#retiringWorkers.delete(retiring);
      this.#observe({
        type: "binding.stopped",
        sandboxId: worker.binding.sandboxId,
        connectionId: worker.binding.connectionId,
        executionLanes: worker.executionLanes,
        cancellationLanes: worker.cancellationLanes,
      });
    });
    this.#retiringWorkers.add(retiring);
  }

  async #stopAllBindings(): Promise<void> {
    for (const [connectionId, worker] of [...this.#bindings]) {
      this.#retireBinding(connectionId, worker);
    }
    await Promise.allSettled([...this.#retiringWorkers]);
  }

  #observe(activity: RemoteSupervisorWorkerActivity): void {
    try {
      this.#onActivity?.(activity);
    } catch {
      // Observability must not become a correctness dependency.
    }
  }
}
