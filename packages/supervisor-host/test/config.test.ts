import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSupervisorHostConfig } from "../src/index.ts";

const roots: string[] = [];

async function secret(root: string, name: string, value: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Supervisor host production configuration", () => {
  it("reads secrets only from private files and derives the WebSocket URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-host-config-"));
    roots.push(root);
    const config = await loadSupervisorHostConfig({
      AGENT_DOCK_SUPERVISOR_ID: "supervisor-production-1",
      AGENT_DOCK_CONTROL_PLANE_URL: "http://control-plane:3000",
      AGENT_DOCK_ALLOW_INSECURE_INTERNAL_HTTP: "true",
      AGENT_DOCK_SUPERVISOR_ENROLLMENT_TOKEN_FILE: await secret(
        root,
        "enrollment",
        `enroll-${"e".repeat(48)}`,
      ),
      AGENT_DOCK_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
        root,
        "management",
        `manage-${"m".repeat(48)}`,
      ),
      DATABASE_URL_FILE: await secret(
        root,
        "database",
        "postgresql://agentdock:secret@postgres:5432/agentdock",
      ),
      AGENT_DOCK_SANDBOX_IMAGE: "agent-dock/sandbox:0.1.0",
      AGENT_DOCK_BOOT_STATE_DIRECTORY: "/var/lib/agent-dock/boot",
      AGENT_DOCK_EVENT_SPOOL_DIRECTORY: "/var/lib/agent-dock/spool",
      AGENT_DOCK_SUPERVISOR_CAPACITY: "3",
    });
    expect(config).toMatchObject({
      supervisorId: "supervisor-production-1",
      supervisorWebSocketUrl: "ws://control-plane:3000/internal/v1/supervisor",
      maxConcurrentSessions: 3,
      managementPort: 4100,
    });
  });

  it("rejects inline secrets and plaintext transport by default", async () => {
    await expect(
      loadSupervisorHostConfig({
        AGENT_DOCK_SUPERVISOR_ID: "supervisor-production-1",
        AGENT_DOCK_CONTROL_PLANE_URL: "http://control-plane:3000",
      }),
    ).rejects.toThrow("Plain HTTP control-plane access requires explicit opt-in");
  });

  it("rejects a world-readable secret file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-host-config-"));
    roots.push(root);
    const enrollment = await secret(root, "enrollment", `enroll-${"e".repeat(48)}`);
    await chmod(enrollment, 0o644);
    await expect(
      loadSupervisorHostConfig({
        AGENT_DOCK_SUPERVISOR_ID: "supervisor-production-1",
        AGENT_DOCK_CONTROL_PLANE_URL: "https://control-plane.example.test",
        AGENT_DOCK_SUPERVISOR_ENROLLMENT_TOKEN_FILE: enrollment,
        AGENT_DOCK_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
          root,
          "management",
          `manage-${"m".repeat(48)}`,
        ),
        DATABASE_URL_FILE: await secret(
          root,
          "database",
          "postgresql://agentdock:secret@postgres:5432/agentdock",
        ),
        AGENT_DOCK_SANDBOX_IMAGE: "agent-dock/sandbox:0.1.0",
        AGENT_DOCK_BOOT_STATE_DIRECTORY: "/var/lib/agent-dock/boot",
        AGENT_DOCK_EVENT_SPOOL_DIRECTORY: "/var/lib/agent-dock/spool",
      }),
    ).rejects.toThrow("not a private bounded regular file");
  });
});
