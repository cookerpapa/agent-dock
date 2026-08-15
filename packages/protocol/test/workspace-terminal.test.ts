import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  parseWorkspaceTerminalClientFrame,
  parseWorkspaceTerminalOpenRequest,
  parseWorkspaceTerminalServerFrame,
  WorkspaceTerminalProtocolError,
} from "../src/index.ts";

const environment = {
  environmentVersionId: "10000000-0000-4000-8000-000000000001",
  versionNumber: 1,
  profileKey: "agent-dock-fullstack",
  profileVersion: "1",
  imageRevision: "development",
  specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};

describe("Workspace terminal protocol", () => {
  it("accepts bounded trusted open and browser PTY frames", () => {
    expect(
      parseWorkspaceTerminalOpenRequest({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.open",
        requestId: "10000000-0000-4000-8000-000000000002",
        tenantId: "10000000-0000-4000-8000-000000000003",
        userId: "10000000-0000-4000-8000-000000000004",
        projectId: "10000000-0000-4000-8000-000000000005",
        workspaceId: "10000000-0000-4000-8000-000000000006",
        sessionId: "10000000-0000-4000-8000-000000000007",
        environment,
        workspaceSeed: { kind: "sample_java" },
        rows: 24,
        cols: 100,
      }),
    ).toMatchObject({ rows: 24, cols: 100 });
    expect(
      parseWorkspaceTerminalClientFrame({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.input",
        data: Buffer.from("pwd\r").toString("base64"),
      }),
    ).toMatchObject({ type: "workspace_terminal.input" });
    expect(
      parseWorkspaceTerminalServerFrame({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.ready",
        terminalId: "10000000-0000-4000-8000-000000000008",
        pid: 73,
        workspaceRoot: "/workspace",
      }),
    ).toMatchObject({ pid: 73 });
  });

  it("rejects identity fields and oversized terminal dimensions in browser frames", () => {
    expect(() =>
      parseWorkspaceTerminalClientFrame({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.resize",
        rows: 24,
        cols: 100,
        tenantId: "10000000-0000-4000-8000-000000000003",
      }),
    ).toThrow(WorkspaceTerminalProtocolError);
    expect(() =>
      parseWorkspaceTerminalClientFrame({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.resize",
        rows: 24,
        cols: 10_000,
      }),
    ).toThrow(WorkspaceTerminalProtocolError);
  });
});
