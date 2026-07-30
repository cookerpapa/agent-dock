import { describe, expect, it } from "vitest";
import {
  TEMPORAL_RUN_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
  TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS,
  temporalRunPriority,
  temporalRunWorkflowId,
  temporalWorkerAffinityTaskQueue,
  validateTemporalRunWorkflowInput,
} from "../src/contract.ts";

const INPUT = {
  schemaVersion: 1 as const,
  tenantId: "a1000000-0000-4000-8000-000000000001",
  sessionId: "a1000000-0000-4000-8000-000000000002",
  runId: "a1000000-0000-4000-8000-000000000003",
  commandId: "a1000000-0000-4000-8000-000000000004",
};

describe("Temporal orchestration contract", () => {
  it("keeps the outer Activity deadline above the bounded Agent and Sandbox cleanup path", () => {
    expect(TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT).toBe("45 minutes");
    expect(TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS).toBe(45 * 60_000);
    expect(TEMPORAL_RUN_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT).toBe("3 hours");
    expect(TEMPORAL_RUN_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS).toBeGreaterThan(
      15 * 60_000 + 15 * 60_000 + 5 * 60_000,
    );
  });

  it("keeps workflow history inputs to bounded durable references", () => {
    expect(validateTemporalRunWorkflowInput(INPUT)).toEqual(INPUT);
    expect(temporalRunWorkflowId(INPUT.runId)).toBe(`agent-dock-run-v1-${INPUT.runId}`);
    expect(JSON.stringify(INPUT)).not.toContain("prompt");
    expect(JSON.stringify(INPUT)).not.toContain("messages");
    expect(JSON.stringify(INPUT)).not.toContain("credential");
  });

  it("routes tenant fairness through Temporal priority metadata", () => {
    expect(temporalRunPriority(INPUT)).toEqual({
      priorityKey: 3,
      fairnessKey: INPUT.tenantId,
      fairnessWeight: 1,
    });
  });

  it("rejects unbounded or non-reference identities", () => {
    expect(() =>
      validateTemporalRunWorkflowInput({ ...INPUT, commandId: "not-a-command" }),
    ).toThrow("commandId must be a UUID");
  });

  it("accepts only a deterministic Worker-specific affinity queue", () => {
    const sandboxId = "a1000000-0000-4000-8000-000000000005";
    const reservationId = "a1000000-0000-4000-8000-000000000006";
    const affinity = {
      reservationId,
      sandboxId,
      taskQueue: temporalWorkerAffinityTaskQueue(sandboxId),
    };
    expect(validateTemporalRunWorkflowInput({ ...INPUT, affinity })).toEqual({
      ...INPUT,
      affinity,
    });
    expect(() =>
      validateTemporalRunWorkflowInput({
        ...INPUT,
        affinity: { ...affinity, taskQueue: "attacker-controlled-queue" },
      }),
    ).toThrow("affinity.taskQueue does not match");
  });
});
