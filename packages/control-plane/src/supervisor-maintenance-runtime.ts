import type { SupervisorMaintenanceCycleResult } from "./supervisor-connection-manager.ts";

const DEFAULT_FAILURE_POLL_MS = 1_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 1_000;
const DEFAULT_MAINTENANCE_CONNECTION_LIMIT = 100;
const DEFAULT_MAINTENANCE_RETIREMENT_LIMIT = 10;

export interface SupervisorMaintenanceRunner {
  runMaintenanceCycle(options?: {
    connectionLimit?: number;
    retirementLimit?: number;
  }): Promise<SupervisorMaintenanceCycleResult>;
}

export type SupervisorMaintenanceActivity =
  | {
      type: "maintenance.completed";
      scannedConnections: number;
      expiredConnections: number;
      retirements: number;
    }
  | {
      type: "runtime.failure";
      component: "maintenance";
      code: string;
      retryable: boolean;
    };

export type SupervisorMaintenanceRuntimeOptions = {
  maintenanceRunner: SupervisorMaintenanceRunner;
  failurePollMs?: number;
  maintenanceIntervalMs?: number;
  maintenanceConnectionLimit?: number;
  maintenanceRetirementLimit?: number;
  onActivity?: (activity: SupervisorMaintenanceActivity) => void;
};

export type SupervisorMaintenanceRuntimeState = "idle" | "running" | "stopping" | "stopped";

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
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
 * Reconciles remote Supervisor connections and orphaned assignments.
 *
 * Run assignment intentionally does not live here: Temporal is the sole
 * scheduler, while this loop only converges infrastructure state.
 */
export class SupervisorMaintenanceRuntime {
  readonly #maintenanceRunner: SupervisorMaintenanceRunner;
  readonly #failurePollMs: number;
  readonly #maintenanceIntervalMs: number;
  readonly #maintenanceConnectionLimit: number;
  readonly #maintenanceRetirementLimit: number;
  readonly #onActivity: ((activity: SupervisorMaintenanceActivity) => void) | undefined;
  #state: SupervisorMaintenanceRuntimeState = "idle";
  #controller: AbortController | undefined;
  #runPromise: Promise<void> | undefined;

  constructor(options: SupervisorMaintenanceRuntimeOptions) {
    this.#maintenanceRunner = options.maintenanceRunner;
    this.#failurePollMs = positiveInteger(
      options.failurePollMs ?? DEFAULT_FAILURE_POLL_MS,
      "failurePollMs",
    );
    this.#maintenanceIntervalMs = positiveInteger(
      options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
      "maintenanceIntervalMs",
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
  }

  get state(): SupervisorMaintenanceRuntimeState {
    return this.#state;
  }

  start(): void {
    if (this.#state !== "idle") {
      throw new Error("Supervisor maintenance runtime was already started");
    }
    this.#state = "running";
    this.#controller = new AbortController();
    this.#runPromise = this.#run(this.#controller.signal).then(() => {
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

  async #run(signal: AbortSignal): Promise<void> {
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
        this.#observe({
          type: "runtime.failure",
          component: "maintenance",
          ...safeFailure(error),
        });
        delayMs = this.#failurePollMs;
      }
      await abortableWait(delayMs, signal);
    }
  }

  #observe(activity: SupervisorMaintenanceActivity): void {
    try {
      this.#onActivity?.(activity);
    } catch {
      // Observability must not become a correctness dependency.
    }
  }
}
