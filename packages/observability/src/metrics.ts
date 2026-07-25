import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

export class AgentDockMetrics {
  readonly registry: Registry;
  readonly runs: Counter<"outcome">;
  readonly queueWait: Histogram;
  readonly runDuration: Histogram<"outcome">;
  readonly sandboxDuration: Histogram<"operation" | "outcome">;
  readonly modelDuration: Histogram<"provider" | "model" | "outcome">;
  readonly modelTokens: Counter<"provider" | "model" | "kind">;
  readonly modelCostMicrousd: Counter<"provider" | "model">;
  readonly toolDuration: Histogram<"tool" | "outcome">;
  readonly checkpointDuration: Histogram<"outcome">;
  readonly checkpointRestoreDuration: Histogram<"outcome">;
  readonly checkpointCacheAccess: Counter<"result">;
  readonly checkpointCacheEntries: Gauge;
  readonly checkpointCacheBytes: Gauge;
  readonly cancellationDuration: Histogram<"outcome">;
  readonly activeRuns: Gauge;
  readonly queuedRuns: Gauge;
  readonly sandboxActive: Gauge<"provider">;
  readonly sandboxPrewarm: Gauge<"provider">;

  constructor(serviceName: string, collectProcessMetrics = false) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: serviceName });
    if (collectProcessMetrics) collectDefaultMetrics({ register: this.registry });
    this.runs = new Counter({
      name: "agent_dock_runs_total",
      help: "Durable Runs settled by outcome",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.queueWait = new Histogram({
      name: "agent_dock_queue_wait_seconds",
      help: "Time from durable acceptance to execution claim",
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.runDuration = new Histogram({
      name: "agent_dock_run_duration_seconds",
      help: "Run execution duration",
      labelNames: ["outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.sandboxDuration = new Histogram({
      name: "agent_dock_sandbox_operation_seconds",
      help: "Sandbox Provider lifecycle operation duration",
      labelNames: ["operation", "outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.modelDuration = new Histogram({
      name: "agent_dock_model_request_seconds",
      help: "Model Gateway request duration",
      labelNames: ["provider", "model", "outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.modelTokens = new Counter({
      name: "agent_dock_model_tokens_total",
      help: "Provider-reported model tokens",
      labelNames: ["provider", "model", "kind"],
      registers: [this.registry],
    });
    this.modelCostMicrousd = new Counter({
      name: "agent_dock_model_cost_microusd_total",
      help: "Model cost in integer micro-USD",
      labelNames: ["provider", "model"],
      registers: [this.registry],
    });
    this.toolDuration = new Histogram({
      name: "agent_dock_tool_duration_seconds",
      help: "Remote tool execution duration",
      labelNames: ["tool", "outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.checkpointDuration = new Histogram({
      name: "agent_dock_checkpoint_duration_seconds",
      help: "Checkpoint capture and commit duration",
      labelNames: ["outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.checkpointRestoreDuration = new Histogram({
      name: "agent_dock_checkpoint_restore_duration_seconds",
      help: "Checkpoint metadata validation and object restoration duration",
      labelNames: ["outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.checkpointCacheAccess = new Counter({
      name: "agent_dock_checkpoint_cache_access_total",
      help: "Worker-local immutable checkpoint cache operations",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.checkpointCacheEntries = new Gauge({
      name: "agent_dock_checkpoint_cache_entries",
      help: "Objects held by the Worker-local immutable checkpoint cache",
      registers: [this.registry],
    });
    this.checkpointCacheBytes = new Gauge({
      name: "agent_dock_checkpoint_cache_bytes",
      help: "Bytes held by the Worker-local immutable checkpoint cache",
      registers: [this.registry],
    });
    this.cancellationDuration = new Histogram({
      name: "agent_dock_cancellation_duration_seconds",
      help: "Cancellation request to confirmed cleanup duration",
      labelNames: ["outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.activeRuns = new Gauge({
      name: "agent_dock_active_runs",
      help: "Active Runs in this process",
      registers: [this.registry],
    });
    this.queuedRuns = new Gauge({
      name: "agent_dock_queued_runs",
      help: "Queued Runs visible to this process",
      registers: [this.registry],
    });
    this.sandboxActive = new Gauge({
      name: "agent_dock_sandbox_active",
      help: "Active sandboxes owned by Provider",
      labelNames: ["provider"],
      registers: [this.registry],
    });
    this.sandboxPrewarm = new Gauge({
      name: "agent_dock_sandbox_prewarm",
      help: "Never-used clean sandboxes waiting for single-consumption claim",
      labelNames: ["provider"],
      registers: [this.registry],
    });
  }
}
