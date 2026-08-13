import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];
const GROUP_SIZE_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024];

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
  readonly turnAdmissionDuration: Histogram<"outcome">;
  readonly tenantAdmissionLockWait: Histogram;
  readonly eventDurabilityDuration: Histogram<"boundary" | "outcome">;
  readonly eventDurabilityGroupSize: Histogram<"boundary">;
  readonly eventProjectionDuration: Histogram<"outcome">;
  readonly eventProjectionLag: Histogram;
  readonly activeRuns: Gauge;
  readonly queuedRuns: Gauge;
  readonly sandboxActive: Gauge<"provider">;
  readonly sandboxAdmissionActive: Gauge<"provider">;
  readonly sandboxAdmissionLimit: Gauge<"provider">;
  readonly sandboxAdmissionWaiting: Gauge<"provider">;
  readonly sandboxAdmissionRejected: Counter<"reason">;
  readonly sandboxPrewarm: Gauge<"provider">;
  readonly workspaceVolumeGatewayActive: Gauge;
  readonly workspaceVolumeGatewayWaiting: Gauge;
  readonly workspaceVolumeGatewayLimit: Gauge;
  readonly workspaceVolumeGatewayQueueWait: Histogram<"operation">;
  readonly workspaceVolumeGatewayDuration: Histogram<"operation" | "outcome">;
  readonly workspaceVolumeGatewayRejected: Counter<"reason">;

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
    this.turnAdmissionDuration = new Histogram({
      name: "agent_dock_turn_admission_seconds",
      help: "Time to idempotently admit or reject a user Turn",
      labelNames: ["outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.tenantAdmissionLockWait = new Histogram({
      name: "agent_dock_tenant_admission_lock_wait_seconds",
      help: "Time waiting for the tenant quota serialization row",
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.eventDurabilityDuration = new Histogram({
      name: "agent_dock_event_durability_seconds",
      help: "Time until a grouped Worker event publication crosses its durable boundary",
      labelNames: ["boundary", "outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.eventDurabilityGroupSize = new Histogram({
      name: "agent_dock_event_durability_group_events",
      help: "Worker events acknowledged in one group commit",
      labelNames: ["boundary"],
      buckets: GROUP_SIZE_BUCKETS,
      registers: [this.registry],
    });
    this.eventProjectionDuration = new Histogram({
      name: "agent_dock_event_projection_seconds",
      help: "Time to project one Kafka Worker-event envelope into the live read model",
      labelNames: ["outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.eventProjectionLag = new Histogram({
      name: "agent_dock_event_projection_lag_seconds",
      help: "Age of the latest Worker event when its live projection completes",
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
    this.sandboxAdmissionActive = new Gauge({
      name: "agent_dock_sandbox_admission_active",
      help: "Materialized Tool Sandboxes currently holding global admission",
      labelNames: ["provider"],
      registers: [this.registry],
    });
    this.sandboxAdmissionLimit = new Gauge({
      name: "agent_dock_sandbox_admission_limit",
      help: "Maximum materialized Tool Sandboxes admitted by this Manager",
      labelNames: ["provider"],
      registers: [this.registry],
    });
    this.sandboxAdmissionWaiting = new Gauge({
      name: "agent_dock_sandbox_admission_waiting",
      help: "Tool Sandbox materializations waiting for global admission",
      labelNames: ["provider"],
      registers: [this.registry],
    });
    this.sandboxAdmissionRejected = new Counter({
      name: "agent_dock_sandbox_admission_rejected_total",
      help: "Sandbox reservations rejected by a bounded capacity policy",
      labelNames: ["reason"],
      registers: [this.registry],
    });
    this.sandboxPrewarm = new Gauge({
      name: "agent_dock_sandbox_prewarm",
      help: "Never-used clean sandboxes waiting for single-consumption claim",
      labelNames: ["provider"],
      registers: [this.registry],
    });
    this.workspaceVolumeGatewayActive = new Gauge({
      name: "agent_dock_workspace_volume_gateway_active",
      help: "Workspace Volume Gateway operations currently executing",
      registers: [this.registry],
    });
    this.workspaceVolumeGatewayWaiting = new Gauge({
      name: "agent_dock_workspace_volume_gateway_waiting",
      help: "Workspace Volume Gateway operations waiting for local execution admission",
      registers: [this.registry],
    });
    this.workspaceVolumeGatewayLimit = new Gauge({
      name: "agent_dock_workspace_volume_gateway_limit",
      help: "Maximum concurrent Workspace Volume Gateway operations in this process",
      registers: [this.registry],
    });
    this.workspaceVolumeGatewayQueueWait = new Histogram({
      name: "agent_dock_workspace_volume_gateway_queue_wait_seconds",
      help: "Time a Workspace Volume Gateway operation waits for local execution admission",
      labelNames: ["operation"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.workspaceVolumeGatewayDuration = new Histogram({
      name: "agent_dock_workspace_volume_gateway_operation_seconds",
      help: "Workspace Volume Gateway operation duration after local admission",
      labelNames: ["operation", "outcome"],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.workspaceVolumeGatewayRejected = new Counter({
      name: "agent_dock_workspace_volume_gateway_rejected_total",
      help: "Workspace Volume Gateway operations rejected before execution",
      labelNames: ["reason"],
      registers: [this.registry],
    });
  }
}
