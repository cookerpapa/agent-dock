import { describe, expect, it } from "vitest";
import { selectPiWorkerExecutionReferences } from "../src/postgres-pi-worker.ts";

describe("PostgreSQL Pi Worker admission", () => {
  it("reserves one multi-slot Worker lane for durable Subagent children", () => {
    const parents = [1, 2, 3, 4].map((index) => ({
      commandId: `parent-${index}`,
      subagent: false,
    }));
    expect(selectPiWorkerExecutionReferences(parents, [], 4)).toEqual(parents.slice(0, 3));
    expect(
      selectPiWorkerExecutionReferences(
        [{ commandId: "child-1", subagent: true }, ...parents],
        parents.slice(0, 3),
        4,
      ),
    ).toEqual([{ commandId: "child-1", subagent: true }]);
  });

  it("uses the full pool when children are already running and keeps single-slot mode valid", () => {
    expect(
      selectPiWorkerExecutionReferences(
        [{ commandId: "parent", subagent: false }],
        [{ commandId: "child", subagent: true }],
        2,
      ),
    ).toEqual([{ commandId: "parent", subagent: false }]);
    expect(
      selectPiWorkerExecutionReferences([{ commandId: "parent", subagent: false }], [], 1),
    ).toEqual([{ commandId: "parent", subagent: false }]);
  });
});
