export const RUN_WORKFLOW_TYPE = "agentDockRunWorkflow";

export type TemporalSpikeMode = "normal" | "crash_recovery" | "cancellation";

export type TemporalRunWorkflowInput = {
  runId: string;
  sessionId: string;
  attemptBaseFence: number;
  promptRef: string;
  piCheckpointRef: string | null;
  workspaceCheckpointRef: string | null;
  policyHash: string;
  mode: TemporalSpikeMode;
  simulatedDurationMs: number;
};

export type TemporalRunActivityResult = {
  runId: string;
  workerId: string;
  activityAttempt: number;
  fencingToken: number;
  promptRef: string;
  checkpointRef: string;
};

export type TemporalSpikeLedgerEntry = {
  phase: "started" | "heartbeat" | "completed" | "cancelled";
  runId: string;
  workerId: string;
  workerPid: number;
  activityAttempt: number;
  fencingToken: number;
  timestamp: string;
};

function bounded(value: string, name: string, maximum = 512): string {
  if (value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function validateWorkflowInput(input: TemporalRunWorkflowInput): TemporalRunWorkflowInput {
  bounded(input.runId, "runId", 128);
  bounded(input.sessionId, "sessionId", 128);
  bounded(input.promptRef, "promptRef", 1_024);
  if (input.piCheckpointRef !== null) bounded(input.piCheckpointRef, "piCheckpointRef", 1_024);
  if (input.workspaceCheckpointRef !== null) {
    bounded(input.workspaceCheckpointRef, "workspaceCheckpointRef", 1_024);
  }
  if (!/^[0-9a-f]{64}$/.test(input.policyHash)) {
    throw new TypeError("policyHash is invalid");
  }
  if (
    !Number.isSafeInteger(input.attemptBaseFence) ||
    input.attemptBaseFence < 1 ||
    !Number.isSafeInteger(input.simulatedDurationMs) ||
    input.simulatedDurationMs < 1 ||
    input.simulatedDurationMs > 60_000
  ) {
    throw new TypeError("Workflow numeric input is invalid");
  }
  if (!["normal", "crash_recovery", "cancellation"].includes(input.mode)) {
    throw new TypeError("Workflow mode is invalid");
  }
  return input;
}
