import { describe, expect, it } from "vitest";
import { validateWorkflowInput, type TemporalRunWorkflowInput } from "../src/contract.ts";

const INPUT: TemporalRunWorkflowInput = {
  runId: "run-1",
  sessionId: "session-1",
  attemptBaseFence: 41,
  promptRef: "postgres://turns/run-1/input",
  piCheckpointRef: "s3://checkpoints/pi/1",
  workspaceCheckpointRef: "s3://checkpoints/workspace/1",
  policyHash: "a".repeat(64),
  mode: "normal",
  simulatedDurationMs: 100,
};

describe("Temporal Run Workflow contract", () => {
  it("accepts bounded references without transcript or credential bytes", () => {
    expect(validateWorkflowInput(INPUT)).toEqual(INPUT);
  });

  it("rejects unbounded or malformed durable history input", () => {
    expect(() => validateWorkflowInput({ ...INPUT, promptRef: "x".repeat(1_025) })).toThrow(
      "promptRef",
    );
    expect(() => validateWorkflowInput({ ...INPUT, policyHash: "secret" })).toThrow("policyHash");
    expect(() => validateWorkflowInput({ ...INPUT, simulatedDurationMs: 0 })).toThrow("numeric");
  });
});
