import {
  ActivityFailure,
  ActivityCancellationType,
  TimeoutFailure,
  continueAsNew,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import {
  TEMPORAL_AGENT_ACTIVITY_MAXIMUM_ATTEMPTS,
  validateTemporalRunWorkflowInput,
  type TemporalRunActivities,
  type TemporalRunActivityResult,
  type TemporalRunWorkflowInput,
} from "./contract.ts";

const MAX_DISPATCH_CYCLES_PER_HISTORY = 200;

const COMMON_ACTIVITY_OPTIONS = {
  startToCloseTimeout: "12 minutes",
  scheduleToCloseTimeout: "30 minutes",
  heartbeatTimeout: "20 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    maximumAttempts: TEMPORAL_AGENT_ACTIVITY_MAXIMUM_ATTEMPTS,
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
      retry: { maximumAttempts: TEMPORAL_AGENT_ACTIVITY_MAXIMUM_ATTEMPTS },
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
