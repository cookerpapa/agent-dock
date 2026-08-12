export const TEMPORAL_RUN_WORKFLOW = "agentDockRunWorkflow";
export const TEMPORAL_RUN_TASK_QUEUE = "agent-dock-pi-runs-cell-0001-v1";
export const TEMPORAL_DEFAULT_NAMESPACE = "agent-dock";
export const TEMPORAL_RUN_WORKFLOW_ID_PREFIX = "agent-dock-run-v1-";
export const TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS = 45 * 60_000;
export const TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT = "45 minutes";
export const TEMPORAL_RUN_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT = "3 hours";

export type TemporalRunWorkflowInput = {
  schemaVersion: 2;
  cellId: string;
  taskQueue: string;
  tenantId: string;
  sessionId: string;
  runId: string;
  commandId: string;
};

export type TemporalRunActivityResult =
  | {
      status: "completed" | "cancelled";
      runId: string;
      commandId: string;
      attempt: number;
    }
  | {
      status: "failed";
      runId: string;
      commandId: string;
      attempt: number;
      failureCode: string;
    }
  | {
      status: "deferred";
      runId: string;
      commandId: string;
      retryAfterMs: number;
    };

export interface TemporalRunActivities {
  executeRunCommand(input: TemporalRunWorkflowInput): Promise<TemporalRunActivityResult>;
}

export type TemporalRunPriority = {
  priorityKey: number;
  fairnessKey: string;
  fairnessWeight: number;
};

function uuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function cellId(value: string): string {
  if (!/^cell-[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/.test(value)) {
    throw new TypeError("cellId is invalid");
  }
  return value;
}

function taskQueue(value: string): string {
  if (value.length < 1 || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("taskQueue is invalid");
  }
  return value;
}

export function validateTemporalRunWorkflowInput(
  value: TemporalRunWorkflowInput,
): TemporalRunWorkflowInput {
  if (value.schemaVersion !== 2) {
    throw new TypeError("Temporal Run input schema version is unsupported");
  }
  return {
    schemaVersion: 2,
    cellId: cellId(value.cellId),
    taskQueue: taskQueue(value.taskQueue),
    tenantId: uuid(value.tenantId, "tenantId"),
    sessionId: uuid(value.sessionId, "sessionId"),
    runId: uuid(value.runId, "runId"),
    commandId: uuid(value.commandId, "commandId"),
  };
}

export function temporalRunWorkflowId(runId: string): string {
  return `${TEMPORAL_RUN_WORKFLOW_ID_PREFIX}${uuid(runId, "runId")}`;
}

/**
 * Temporal, rather than a PostgreSQL polling loop, owns cross-tenant task
 * fairness. Keeping the policy beside the durable input makes that scheduling
 * contract independently testable.
 */
export function temporalRunPriority(input: TemporalRunWorkflowInput): TemporalRunPriority {
  const validated = validateTemporalRunWorkflowInput(input);
  return {
    priorityKey: 3,
    fairnessKey: validated.tenantId,
    fairnessWeight: 1,
  };
}
