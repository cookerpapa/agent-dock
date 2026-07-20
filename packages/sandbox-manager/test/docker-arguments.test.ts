import type { ToolSandboxAssignment } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_SANDBOX_POLICY,
  buildToolSandboxDockerArguments,
  type SandboxPolicy,
} from "../src/index.ts";

const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-security-test",
  supervisorId: "supervisor-security-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  commandId: "command-security-test",
  sessionId: "session-security-test",
  turnId: "turn-security-test",
  attemptId: "10000000-0000-4000-8000-000000000003",
  leaseId: "10000000-0000-4000-8000-000000000003",
  fencingToken: 7,
};

describe("Tool Sandbox Docker boundary", () => {
  it("creates an offline, unprivileged, immutable and mount-free worker", () => {
    const args = buildToolSandboxDockerArguments(
      "agent-dock/tool-sandbox:test",
      "agent-dock-tool-security-test",
      "10000000-0000-4000-8000-000000000004",
      assignment,
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--user",
        "1000:1000",
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
      ]),
    );
    expect(args.at(-1)).toBe("agent-dock/tool-sandbox:test");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("--env-file");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--mount");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("admg_");
    expect(args).toContain("agent-dock.tenant-id=tenant-security-test");
    expect(args).toContain("agent-dock.attempt-id=10000000-0000-4000-8000-000000000003");
  });

  it("fails closed instead of attaching a Tool Sandbox to an egress network", () => {
    const unsupported = {
      ...DEFAULT_TOOL_SANDBOX_POLICY,
      network: { mode: "github" },
    } as SandboxPolicy;
    expect(() =>
      buildToolSandboxDockerArguments(
        "agent-dock/tool-sandbox:test",
        "agent-dock-tool-security-test",
        "10000000-0000-4000-8000-000000000004",
        assignment,
        unsupported,
      ),
    ).toThrow("does not support");
  });
});
