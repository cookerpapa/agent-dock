import { describe, expect, it } from "vitest";
import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import { buildDockerSandboxRunArguments } from "../src/index.ts";

const command: ExecuteTurnCommandMessage = {
  protocolVersion: 1,
  messageId: "10000000-0000-4000-8000-000000000001",
  sentAt: "2026-07-19T00:00:00.000Z",
  type: "command.turn.execute",
  payload: {
    commandId: "20000000-0000-4000-8000-000000000001",
    idempotencyKey: "docker-run-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    agentId: "root",
    leaseId: "30000000-0000-4000-8000-000000000001",
    fencingToken: 1,
    nextEventSeq: 1,
    input: { kind: "prompt", text: "Repair the Java test." },
    model: {
      profileId: "profile-1",
      provider: "agent-dock-fake",
      modelId: "agent-dock-fake",
      thinkingLevel: "off",
      credentialBindingId: "credential-1",
      credentialBindingVersion: 1,
    },
  },
};

describe("DockerSandboxTurnRunner", () => {
  it("builds a hardened, networkless container without host mounts or secret environment", () => {
    const args = buildDockerSandboxRunArguments(
      "agent-dock/pi-workspace:test",
      "agent-dock-test-run",
      command,
    );
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--interactive"]);
    expect(args.at(-1)).toBe("agent-dock/pi-workspace:test");
    expect(args).toEqual(
      expect.arrayContaining([
        "--user",
        "1000:1000",
        "--read-only",
        "--network",
        "none",
        "--init",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "768m",
        "--cpus",
        "1.0",
      ]),
    );
    expect(args.filter((argument) => argument === "--tmpfs")).toHaveLength(2);
    expect(args.some((argument) => argument.includes("/workspace:rw"))).toBe(true);
    expect(
      args.some((argument) => /docker\.sock|\/home\/|\\\\wsl|providerToken/.test(argument)),
    ).toBe(false);
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--mount");
    expect(args).not.toContain("--publish");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("--privileged");
  });

  it("rejects invalid container names before invoking Docker", () => {
    expect(() =>
      buildDockerSandboxRunArguments("agent-dock/pi-workspace:test", "../escape", command),
    ).toThrow("container name is invalid");
  });
});
