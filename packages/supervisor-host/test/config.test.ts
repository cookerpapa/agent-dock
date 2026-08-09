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
      AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "http://supervisor-production-1:4100",
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
      AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: await secret(
        root,
        "sandbox-manager",
        `sandbox-manager-${"s".repeat(48)}`,
      ),
      AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY_FILE: await secret(
        root,
        "model-master-key",
        Buffer.alloc(32, 9).toString("base64url"),
      ),
      DATABASE_URL_FILE: await secret(
        root,
        "database",
        "postgresql://agentdock:secret@postgres:5432/agentdock",
      ),
      AGENT_DOCK_SANDBOX_MANAGER_URLS: "http://sandbox-manager:4300",
      AGENT_DOCK_TRUSTED_WORKSPACE_DIRECTORY: "/workspace",
      AGENT_DOCK_BOOT_STATE_DIRECTORY: "/var/lib/agent-dock/boot",
      AGENT_DOCK_EVENT_SPOOL_DIRECTORY: "/var/lib/agent-dock/spool",
      AGENT_DOCK_SUPERVISOR_CAPACITY: "1",
      AGENT_DOCK_TEMPORAL_ADDRESS: "temporal:7233",
      AGENT_DOCK_MODEL_GATEWAY_ADVERTISED_URL: "http://127.0.0.1:4200",
    });
    expect(config).toMatchObject({
      supervisorId: "supervisor-production-1",
      supervisorWebSocketUrl: "ws://control-plane:3000/internal/v1/supervisor",
      maxConcurrentSessions: 1,
      temporalAddress: "temporal:7233",
      temporalNamespace: "agent-dock",
      executionCellId: "cell-0001",
      temporalTaskQueue: "agent-dock-pi-runs-cell-0001-v1",
      managementPort: 4100,
      managementAdvertisedBaseUrl: "http://supervisor-production-1:4100/",
      sandboxManagerBaseUrls: ["http://sandbox-manager:4300/"],
      trustedWorkspaceDirectory: "/workspace",
      checkpointReadCacheTtlMs: 600_000,
      checkpointReadCacheMaximumEntries: 512,
      checkpointReadCacheMaximumBytes: 32 * 1_024 * 1_024,
    });
    expect(config.temporalWorkerDeploymentName).toBeUndefined();
    expect(config.temporalWorkerBuildId).toBeUndefined();
  });

  it("requires a complete Temporal Worker Deployment identity when versioning is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-host-config-"));
    roots.push(root);
    const environment = {
      AGENT_DOCK_SUPERVISOR_ID: "supervisor-production-1",
      AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "http://supervisor-production-1:4100",
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
      AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: await secret(
        root,
        "sandbox-manager",
        `sandbox-manager-${"s".repeat(48)}`,
      ),
      AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY_FILE: await secret(
        root,
        "model-master-key",
        Buffer.alloc(32, 9).toString("base64url"),
      ),
      DATABASE_URL_FILE: await secret(
        root,
        "database",
        "postgresql://agentdock:secret@postgres:5432/agentdock",
      ),
      AGENT_DOCK_SANDBOX_MANAGER_URLS: "http://sandbox-manager:4300",
      AGENT_DOCK_TRUSTED_WORKSPACE_DIRECTORY: "/workspace",
      AGENT_DOCK_BOOT_STATE_DIRECTORY: "/var/lib/agent-dock/boot",
      AGENT_DOCK_EVENT_SPOOL_DIRECTORY: "/var/lib/agent-dock/spool",
      AGENT_DOCK_TEMPORAL_ADDRESS: "temporal:7233",
      AGENT_DOCK_MODEL_GATEWAY_ADVERTISED_URL: "http://127.0.0.1:4200",
      AGENT_DOCK_TEMPORAL_WORKER_VERSIONING_ENABLED: "true",
    };
    await expect(loadSupervisorHostConfig(environment)).rejects.toThrow(
      "AGENT_DOCK_TEMPORAL_WORKER_DEPLOYMENT_NAME",
    );
    const config = await loadSupervisorHostConfig({
      ...environment,
      AGENT_DOCK_TEMPORAL_WORKER_DEPLOYMENT_NAME: "agent-dock-pi-workers",
      AGENT_DOCK_TEMPORAL_WORKER_BUILD_ID: "revision-123",
    });
    expect(config.temporalWorkerDeploymentName).toBe("agent-dock-pi-workers");
    expect(config.temporalWorkerBuildId).toBe("revision-123");
  });

  it("accepts a private group-readable Kubernetes Secret projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-host-config-"));
    roots.push(root);
    const enrollment = await secret(root, "enrollment", `enroll-${"e".repeat(48)}`);
    await chmod(enrollment, 0o640);
    await expect(
      loadSupervisorHostConfig({
        AGENT_DOCK_SUPERVISOR_ID: "supervisor-production-1",
        AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "http://supervisor-production-1:4100",
        AGENT_DOCK_CONTROL_PLANE_URL: "http://control-plane:3000",
        AGENT_DOCK_ALLOW_INSECURE_INTERNAL_HTTP: "true",
        AGENT_DOCK_SUPERVISOR_ENROLLMENT_TOKEN_FILE: enrollment,
        AGENT_DOCK_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
          root,
          "management",
          `manage-${"m".repeat(48)}`,
        ),
        AGENT_DOCK_SANDBOX_MANAGER_TOKEN_FILE: await secret(
          root,
          "sandbox-manager",
          `sandbox-manager-${"s".repeat(48)}`,
        ),
        AGENT_DOCK_MODEL_CREDENTIAL_MASTER_KEY_FILE: await secret(
          root,
          "model-master-key",
          Buffer.alloc(32, 9).toString("base64url"),
        ),
        DATABASE_URL_FILE: await secret(
          root,
          "database",
          "postgresql://agentdock:secret@postgres:5432/agentdock",
        ),
        AGENT_DOCK_SANDBOX_MANAGER_URLS: "http://sandbox-manager:4300",
        AGENT_DOCK_TRUSTED_WORKSPACE_DIRECTORY: "/workspace",
        AGENT_DOCK_BOOT_STATE_DIRECTORY: "/var/lib/agent-dock/boot",
        AGENT_DOCK_EVENT_SPOOL_DIRECTORY: "/var/lib/agent-dock/spool",
        AGENT_DOCK_TEMPORAL_ADDRESS: "temporal:7233",
        AGENT_DOCK_MODEL_GATEWAY_ADVERTISED_URL: "http://127.0.0.1:4200",
      }),
    ).resolves.toMatchObject({ enrollmentToken: `enroll-${"e".repeat(48)}` });
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
        AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "https://supervisor-production-1:4100",
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
