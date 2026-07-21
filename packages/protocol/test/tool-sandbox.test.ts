import { describe, expect, it } from "vitest";
import {
  parseSandboxManagerRequest,
  parseToolSandboxOperationRequest,
  parseToolWorkerOutput,
  ToolSandboxProtocolError,
} from "../src/index.ts";

const assignment = {
  tenantId: "tenant-tool-protocol",
  projectId: "project-tool-protocol",
  workspaceId: "workspace-tool-protocol",
  supervisorId: "supervisor-tool-protocol",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  commandId: "command-tool-protocol",
  sessionId: "session-tool-protocol",
  turnId: "turn-tool-protocol",
  attemptId: "10000000-0000-4000-8000-000000000003",
  leaseId: "10000000-0000-4000-8000-000000000003",
  fencingToken: 9,
} as const;

describe("Tool Sandbox protocol", () => {
  it("parses a closed, fully fenced create request", () => {
    expect(
      parseSandboxManagerRequest({
        managerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: "10000000-0000-4000-8000-000000000004",
        assignment,
        workspaceSeed: { kind: "sample_java" },
      }),
    ).toMatchObject({ type: "tool_sandbox.create", assignment });
  });

  it("rejects unknown fields and out-of-bound operation parameters", () => {
    expect(() =>
      parseToolSandboxOperationRequest({
        managerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        activationId: "10000000-0000-4000-8000-000000000005",
        operationId: "10000000-0000-4000-8000-000000000006",
        operation: "bash.exec",
        command: "pwd",
        cwd: "/workspace",
        timeoutMs: 300_001,
      }),
    ).toThrow(ToolSandboxProtocolError);
    expect(() =>
      parseSandboxManagerRequest({
        managerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: "10000000-0000-4000-8000-000000000007",
        assignment: { ...assignment, unexpected: true },
        workspaceSeed: { kind: "sample_java" },
      }),
    ).toThrow(ToolSandboxProtocolError);
  });

  it("binds every worker result to activation and operation identities", () => {
    expect(
      parseToolWorkerOutput({
        toolWorkerProtocolVersion: 1,
        type: "worker.operation_result",
        response: {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: "10000000-0000-4000-8000-000000000008",
          operationId: "10000000-0000-4000-8000-000000000009",
          operation: "file.read",
          content: Buffer.from("isolated\n").toString("base64"),
        },
      }),
    ).toMatchObject({
      type: "worker.operation_result",
      response: { operation: "file.read" },
    });
  });
});
