import {
  ActivityFailure,
  ActivityCancellationType,
  TimeoutFailure,
  continueAsNew,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import {
  TEMPORAL_RUN_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
  TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  validateTemporalRunWorkflowInput,
  type TemporalRunActivities,
  type TemporalRunActivityResult,
  type TemporalRunWorkflowInput,
} from "./contract.ts";

const MAX_DISPATCH_CYCLES_PER_HISTORY = 200;

const COMMON_ACTIVITY_OPTIONS = {
  startToCloseTimeout: TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  scheduleToCloseTimeout: TEMPORAL_RUN_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
  heartbeatTimeout: "20 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
} as const;

const { executeRunCommand } = proxyActivities<TemporalRunActivities>(COMMON_ACTIVITY_OPTIONS);

function withoutAffinity(input: TemporalRunWorkflowInput): TemporalRunWorkflowInput {
  const { affinity: _affinity, ...common } = input;
  return common;
}

function isScheduleToStartTimeout(error: unknown): boolean {
  return (
    error instanceof ActivityFailure &&
    error.cause instanceof TimeoutFailure &&
    error.cause.timeoutType === "SCHEDULE_TO_START"
  );
}

export async function agentDockRunWorkflow(
  rawInput: TemporalRunWorkflowInput,
): Promise<TemporalRunActivityResult> {
  const input = validateTemporalRunWorkflowInput(rawInput);
  const commonInput = withoutAffinity(input);
  if (input.affinity !== undefined) {
    const { executeRunCommand: executePreferred } = proxyActivities<TemporalRunActivities>({
      ...COMMON_ACTIVITY_OPTIONS,
      taskQueue: input.affinity.taskQueue,
      scheduleToStartTimeout: "2 seconds",
      retry: { maximumAttempts: 1 },
    });
    try {
      const preferred = await executePreferred(input);
      if (preferred.status !== "affinity_miss" && preferred.status !== "deferred") {
        return preferred;
      }
    } catch (error: unknown) {
      if (!isScheduleToStartTimeout(error)) throw error;
    }
  }
  for (let cycle = 0; cycle < MAX_DISPATCH_CYCLES_PER_HISTORY; cycle += 1) {
    const result = await executeRunCommand(commonInput);
    if (result.status !== "deferred") return result;
    await sleep(result.retryAfterMs);
  }
  return continueAsNew<typeof agentDockRunWorkflow>(commonInput);
}
