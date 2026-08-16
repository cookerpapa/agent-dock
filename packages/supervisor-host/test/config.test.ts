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

async function validEnvironment(root: string): Promise<Record<string, string>> {
  return {
    PI_CLOUD_SUPERVISOR_ID: "supervisor-production-1",
    PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "http://supervisor-production-1:4100",
    PI_CLOUD_CONTROL_PLANE_URL: "http://control-plane:3000",
    PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP: "true",
    PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN_FILE: await secret(
      root,
      "timing-enrollment",
      `enroll-${"e".repeat(48)}`,
    ),
    PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
      root,
      "timing-management",
      `manage-${"m".repeat(48)}`,
    ),
    PI_CLOUD_TOOL_BROKER_TOKEN_FILE: await secret(
      root,
      "timing-tool-broker",
      `tool-broker-${"s".repeat(48)}`,
    ),
    PI_CLOUD_MODEL_CREDENTIAL_MASTER_KEY_FILE: await secret(
      root,
      "timing-model-master-key",
      Buffer.alloc(32, 9).toString("base64url"),
    ),
    DATABASE_URL_FILE: await secret(
      root,
      "timing-database",
      "postgresql://picloud:secret@postgres:5432/picloud",
    ),
    PI_CLOUD_TOOL_BROKER_URLS: "http://tool-broker:4300",
    PI_CLOUD_TRUSTED_WORKSPACE_DIRECTORY: "/workspace",
    PI_CLOUD_BOOT_STATE_DIRECTORY: "/var/lib/pi-cloud/boot",
    PI_CLOUD_EVENT_SPOOL_DIRECTORY: "/var/lib/pi-cloud/spool",
    PI_CLOUD_MODEL_GATEWAY_ADVERTISED_URL: "http://127.0.0.1:4200",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Supervisor host production configuration", () => {
  it("reads secrets only from private files and derives the WebSocket URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-host-config-"));
    roots.push(root);
    const config = await loadSupervisorHostConfig({
      PI_CLOUD_SUPERVISOR_ID: "supervisor-production-1",
      PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "http://supervisor-production-1:4100",
      PI_CLOUD_CONTROL_PLANE_URL: "http://control-plane:3000",
      PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP: "true",
      PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN_FILE: await secret(
        root,
        "enrollment",
        `enroll-${"e".repeat(48)}`,
      ),
      PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
        root,
        "management",
        `manage-${"m".repeat(48)}`,
      ),
      PI_CLOUD_TOOL_BROKER_TOKEN_FILE: await secret(
        root,
        "tool-broker",
        `tool-broker-${"s".repeat(48)}`,
      ),
      PI_CLOUD_MODEL_CREDENTIAL_MASTER_KEY_FILE: await secret(
        root,
        "model-master-key",
        Buffer.alloc(32, 9).toString("base64url"),
      ),
      DATABASE_URL_FILE: await secret(
        root,
        "database",
        "postgresql://picloud:secret@postgres:5432/picloud",
      ),
      PI_CLOUD_TOOL_BROKER_URLS: "http://tool-broker:4300",
      PI_CLOUD_TRUSTED_WORKSPACE_DIRECTORY: "/workspace",
      PI_CLOUD_BOOT_STATE_DIRECTORY: "/var/lib/pi-cloud/boot",
      PI_CLOUD_EVENT_SPOOL_DIRECTORY: "/var/lib/pi-cloud/spool",
      PI_CLOUD_SUPERVISOR_CAPACITY: "1",
      PI_CLOUD_MODEL_GATEWAY_ADVERTISED_URL: "http://127.0.0.1:4200",
    });
    expect(config).toMatchObject({
      supervisorId: "supervisor-production-1",
      supervisorWebSocketUrl: "ws://control-plane:3000/internal/v1/supervisor",
      maxConcurrentSessions: 1,
      databaseNotificationUrl: "postgresql://picloud:secret@postgres:5432/picloud",
      managementPort: 4100,
      managementAdvertisedBaseUrl: "http://supervisor-production-1:4100/",
      toolBrokerBaseUrls: ["http://tool-broker:4300/"],
      trustedWorkspaceDirectory: "/workspace",
      checkpointReadCacheTtlMs: 600_000,
      checkpointReadCacheMaximumEntries: 512,
      checkpointReadCacheMaximumBytes: 32 * 1_024 * 1_024,
    });
  });

  it("rejects timeout combinations that can expire an upstream boundary first", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-host-config-"));
    roots.push(root);
    const environment = await validEnvironment(root);

    await expect(
      loadSupervisorHostConfig({
        ...environment,
        PI_CLOUD_TOOL_BROKER_REQUEST_TIMEOUT_MS: "300000",
      }),
    ).rejects.toThrow("maximum Tool execution");
    await expect(
      loadSupervisorHostConfig({
        ...environment,
        PI_CLOUD_MODEL_GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: "151000",
        PI_CLOUD_PI_MODEL_REQUEST_TIMEOUT_MS: "150000",
      }),
    ).rejects.toThrow("upstream timeout");
    await expect(
      loadSupervisorHostConfig({
        ...environment,
        PI_CLOUD_MODEL_GATEWAY_CAPABILITY_TTL_MS: "600000",
      }),
    ).rejects.toThrow("capability TTL");
    await expect(
      loadSupervisorHostConfig({
        ...environment,
        PI_CLOUD_REPOSITORY_IMPORT_LEASE_MS: "300000",
        PI_CLOUD_REPOSITORY_IMPORT_WAIT_MS: "299999",
      }),
    ).rejects.toThrow("ownership lease");
  });

  it("accepts a private group-readable Kubernetes Secret projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-host-config-"));
    roots.push(root);
    const enrollment = await secret(root, "enrollment", `enroll-${"e".repeat(48)}`);
    await chmod(enrollment, 0o640);
    await expect(
      loadSupervisorHostConfig({
        PI_CLOUD_SUPERVISOR_ID: "supervisor-production-1",
        PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "http://supervisor-production-1:4100",
        PI_CLOUD_CONTROL_PLANE_URL: "http://control-plane:3000",
        PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP: "true",
        PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN_FILE: enrollment,
        PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
          root,
          "management",
          `manage-${"m".repeat(48)}`,
        ),
        PI_CLOUD_TOOL_BROKER_TOKEN_FILE: await secret(
          root,
          "tool-broker",
          `tool-broker-${"s".repeat(48)}`,
        ),
        PI_CLOUD_MODEL_CREDENTIAL_MASTER_KEY_FILE: await secret(
          root,
          "model-master-key",
          Buffer.alloc(32, 9).toString("base64url"),
        ),
        DATABASE_URL_FILE: await secret(
          root,
          "database",
          "postgresql://picloud:secret@postgres:5432/picloud",
        ),
        PI_CLOUD_TOOL_BROKER_URLS: "http://tool-broker:4300",
        PI_CLOUD_TRUSTED_WORKSPACE_DIRECTORY: "/workspace",
        PI_CLOUD_BOOT_STATE_DIRECTORY: "/var/lib/pi-cloud/boot",
        PI_CLOUD_EVENT_SPOOL_DIRECTORY: "/var/lib/pi-cloud/spool",
        PI_CLOUD_MODEL_GATEWAY_ADVERTISED_URL: "http://127.0.0.1:4200",
      }),
    ).resolves.toMatchObject({ enrollmentToken: `enroll-${"e".repeat(48)}` });
  });

  it("rejects inline secrets and plaintext transport by default", async () => {
    await expect(
      loadSupervisorHostConfig({
        PI_CLOUD_SUPERVISOR_ID: "supervisor-production-1",
        PI_CLOUD_CONTROL_PLANE_URL: "http://control-plane:3000",
      }),
    ).rejects.toThrow("Plain HTTP control-plane access requires explicit opt-in");
  });

  it("rejects a world-readable secret file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-host-config-"));
    roots.push(root);
    const enrollment = await secret(root, "enrollment", `enroll-${"e".repeat(48)}`);
    await chmod(enrollment, 0o644);
    await expect(
      loadSupervisorHostConfig({
        PI_CLOUD_SUPERVISOR_ID: "supervisor-production-1",
        PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL: "https://supervisor-production-1:4100",
        PI_CLOUD_CONTROL_PLANE_URL: "https://control-plane.example.test",
        PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN_FILE: enrollment,
        PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE: await secret(
          root,
          "management",
          `manage-${"m".repeat(48)}`,
        ),
        DATABASE_URL_FILE: await secret(
          root,
          "database",
          "postgresql://picloud:secret@postgres:5432/picloud",
        ),
        PI_CLOUD_SANDBOX_IMAGE: "pi-cloud/sandbox:0.1.0",
        PI_CLOUD_BOOT_STATE_DIRECTORY: "/var/lib/pi-cloud/boot",
        PI_CLOUD_EVENT_SPOOL_DIRECTORY: "/var/lib/pi-cloud/spool",
      }),
    ).rejects.toThrow("not a private bounded regular file");
  });
});
