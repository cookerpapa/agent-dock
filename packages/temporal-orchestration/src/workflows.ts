import {
  ActivityCancellationType,
  continueAsNew,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import {
  validateTemporalRunWorkflowInput,
  type TemporalRunActivities,
  type TemporalRunActivityResult,
  type TemporalRunWorkflowInput,
} from "./contract.ts";

const MAX_DISPATCH_CYCLES_PER_HISTORY = 200;

const { executeRunCommand } = proxyActivities<TemporalRunActivities>({
  startToCloseTimeout: "12 minutes",
  scheduleToCloseTimeout: "30 minutes",
  heartbeatTimeout: "20 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

export async function agentDockRunWorkflow(
  rawInput: TemporalRunWorkflowInput,
): Promise<TemporalRunActivityResult> {
  const input = validateTemporalRunWorkflowInput(rawInput);
  for (let cycle = 0; cycle < MAX_DISPATCH_CYCLES_PER_HISTORY; cycle += 1) {
    const result = await executeRunCommand(input);
    if (result.status !== "deferred") return result;
    await sleep(result.retryAfterMs);
  }
  return continueAsNew<typeof agentDockRunWorkflow>(input);
}
