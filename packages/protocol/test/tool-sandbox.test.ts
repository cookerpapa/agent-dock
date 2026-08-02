import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  parseSandboxManagerRequest,
  parseSandboxManagerResponse,
  parseToolSandboxOperationRequest,
  parseToolWorkerOutput,
  ToolSandboxProtocolError,
} from "../src/index.ts";

const environment = {
  environmentVersionId: "10000000-0000-4000-8000-000000000010",
  versionNumber: 1,
  profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  imageRevision: "sha-0123456789abcdef",
  specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} as const;

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
        environment,
        workspaceSeed: { kind: "sample_java" },
      }),
    ).toMatchObject({ type: "tool_sandbox.create", assignment });
  });

  it("makes physical runtime continuity explicit in create responses", () => {
    const response = {
      managerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: "10000000-0000-4000-8000-000000000004",
      activationId: "10000000-0000-4000-8000-000000000005",
      capability: `adts_${"x".repeat(43)}`,
      workspaceRoot: "/workspace",
      continuity: "cold_restore",
    } as const;
    expect(parseSandboxManagerResponse(response)).toMatchObject({
      type: "tool_sandbox.reserved",
      continuity: "cold_restore",
    });
    expect(() =>
      parseSandboxManagerResponse({
        managerProtocolVersion: 1,
        type: "tool_sandbox.reserved",
        requestId: response.requestId,
        activationId: response.activationId,
        capability: response.capability,
        workspaceRoot: "/workspace",
      }),
    ).toThrow(ToolSandboxProtocolError);
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
        environment,
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
          sha256: "b56cd21cdde6e2f4df2a1d34322d092ede320284fb273345ee0de579b1d32dce",
        },
      }),
    ).toMatchObject({
      type: "worker.operation_result",
      response: { operation: "file.read" },
    });
  });
});
