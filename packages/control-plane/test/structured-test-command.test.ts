import { describe, expect, it } from "vitest";
import { classifyStructuredTestCommand } from "@pi-cloud/runtime-core/structured-test-command";

describe("structured test command classification", () => {
  it("canonicalizes setup variants that execute the same Workspace test", () => {
    const commands = [
      "cd /workspace && ./eval/test.sh subtract",
      "chmod +x /workspace/eval/test.sh && cd /workspace && ./eval/test.sh subtract",
      "cd /workspace && chmod +x eval/test.sh && /workspace/eval/test.sh subtract",
    ];
    const invocations = commands.map(classifyStructuredTestCommand);
    expect(invocations.every((invocation) => invocation !== undefined)).toBe(true);
    expect(new Set(invocations.map((invocation) => invocation?.key))).toEqual(
      new Set(["eval/test.sh\u001fsubtract"]),
    );
    expect(invocations.map((invocation) => invocation?.suite)).toEqual([
      "test.sh",
      "test.sh",
      "test.sh",
    ]);
  });

  it("does not mistake a test-looking filename passed to another program for execution", () => {
    expect(classifyStructuredTestCommand("cd /workspace && ls -la eval/ test.sh")).toBeUndefined();
    expect(classifyStructuredTestCommand("find . -name '*test.sh'")).toBeUndefined();
  });

  it("recognizes supported test runners with environment and shell prefixes", () => {
    expect(classifyStructuredTestCommand("CI=1 npm test -- --runInBand")?.suite).toBe("npm");
    expect(classifyStructuredTestCommand("env MODE=test python3 -m pytest -q")?.suite).toBe(
      "python3",
    );
    expect(classifyStructuredTestCommand("cd /workspace; bash ./checks/check-unit.sh")?.suite).toBe(
      "check-unit.sh",
    );
    expect(classifyStructuredTestCommand("go test ./...")?.suite).toBe("go");
  });
});
