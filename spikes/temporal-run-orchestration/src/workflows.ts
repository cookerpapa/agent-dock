import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.ts";
import {
  validateWorkflowInput,
  type TemporalRunActivityResult,
  type TemporalRunWorkflowInput,
} from "./contract.ts";

const { executeRunAttempt } = proxyActivities<typeof activities>({
  startToCloseTimeout: "70 seconds",
  heartbeatTimeout: "2 seconds",
  scheduleToCloseTimeout: "90 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "250 milliseconds",
    backoffCoefficient: 1,
    maximumInterval: "250 milliseconds",
    maximumAttempts: 3,
  },
});

export async function agentDockRunWorkflow(
  rawInput: TemporalRunWorkflowInput,
): Promise<TemporalRunActivityResult> {
  const input = validateWorkflowInput(rawInput);
  return executeRunAttempt(input);
}
