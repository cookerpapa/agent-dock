export const TEMPORAL_RUN_WORKFLOW = "agentDockRunWorkflow";
export const TEMPORAL_RUN_TASK_QUEUE = "agent-dock-pi-runs-v1";
export const TEMPORAL_DEFAULT_NAMESPACE = "agent-dock";
export const TEMPORAL_RUN_WORKFLOW_ID_PREFIX = "agent-dock-run-v1-";

export type TemporalRunWorkflowInput = {
  schemaVersion: 1;
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

function uuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

export function validateTemporalRunWorkflowInput(
  value: TemporalRunWorkflowInput,
): TemporalRunWorkflowInput {
  if (value.schemaVersion !== 1) {
    throw new TypeError("Temporal Run input schema version is unsupported");
  }
  return {
    schemaVersion: 1,
    tenantId: uuid(value.tenantId, "tenantId"),
    sessionId: uuid(value.sessionId, "sessionId"),
    runId: uuid(value.runId, "runId"),
    commandId: uuid(value.commandId, "commandId"),
  };
}

export function temporalRunWorkflowId(runId: string): string {
  return `${TEMPORAL_RUN_WORKFLOW_ID_PREFIX}${uuid(runId, "runId")}`;
}
