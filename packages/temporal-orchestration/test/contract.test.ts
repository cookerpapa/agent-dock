import { describe, expect, it } from "vitest";
import { temporalRunWorkflowId, validateTemporalRunWorkflowInput } from "../src/contract.ts";

const INPUT = {
  schemaVersion: 1 as const,
  tenantId: "a1000000-0000-4000-8000-000000000001",
  sessionId: "a1000000-0000-4000-8000-000000000002",
  runId: "a1000000-0000-4000-8000-000000000003",
  commandId: "a1000000-0000-4000-8000-000000000004",
};

describe("Temporal orchestration contract", () => {
  it("keeps workflow history inputs to bounded durable references", () => {
    expect(validateTemporalRunWorkflowInput(INPUT)).toEqual(INPUT);
    expect(temporalRunWorkflowId(INPUT.runId)).toBe(`agent-dock-run-v1-${INPUT.runId}`);
    expect(JSON.stringify(INPUT)).not.toContain("prompt");
    expect(JSON.stringify(INPUT)).not.toContain("messages");
    expect(JSON.stringify(INPUT)).not.toContain("credential");
  });

  it("rejects unbounded or non-reference identities", () => {
    expect(() =>
      validateTemporalRunWorkflowInput({ ...INPUT, commandId: "not-a-command" }),
    ).toThrow("commandId must be a UUID");
  });
});
