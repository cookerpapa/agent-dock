import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HttpWorkspaceDataMover,
  KopiaWorkspaceDataMover,
  WorkspaceDataMoverServer,
  workspaceVolumeId,
  type WorkspaceDataMover,
} from "../src/index.ts";

const TOKEN = `mover-${"m".repeat(48)}`;
const identity = Object.freeze({
  tenantId: "tenant-data-mover",
  workspaceId: "workspace-data-mover",
  sessionId: "session-data-mover",
  volumeId: workspaceVolumeId({
    tenantId: "tenant-data-mover",
    workspaceId: "workspace-data-mover",
    sessionId: "session-data-mover",
  }),
});

describe("trusted Workspace Data Mover", () => {
  it("keeps its authenticated API narrow and verifies materialized bytes", async () => {
    const bytes = Buffer.from("durable\n");
    const mover: WorkspaceDataMover = {
      checkHealth: vi.fn(async () => undefined),
      prepare: vi.fn(async () => ({ restored: true })),
      snapshot: vi.fn(async () => ({ snapshotId: "snapshot-durable" })),
      materialize: vi.fn(async () => ({
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
      close: vi.fn(async () => undefined),
    };
    const server = new WorkspaceDataMoverServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: TOKEN,
      mover,
    });
    const address = await server.listen();
    try {
      const unauthorized = await fetch(new URL("/v1/workspaces/prepare", address), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(identity),
      });
      expect(unauthorized.status).toBe(401);

      const client = new HttpWorkspaceDataMover({
        baseUrl: address,
        serviceToken: TOKEN,
      });
      await expect(
        client.prepare({ ...identity, snapshotId: "snapshot-durable" }),
      ).resolves.toEqual({ restored: true });
      await expect(
        client.materialize({
          ...identity,
          snapshotId: "snapshot-durable",
          path: "result.txt",
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
          maximumBytes: 1_024,
        }),
      ).resolves.toEqual({
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(mover.prepare).toHaveBeenCalledWith({
        ...identity,
        snapshotId: "snapshot-durable",
      });
    } finally {
      await server.close();
    }
  });

  it("derives a tenant-bound volume identity and rejects traversal before invoking Kopia", async () => {
    expect(workspaceVolumeId(identity)).toBe(identity.volumeId);
    expect(workspaceVolumeId({ ...identity, tenantId: "tenant-data-mover-other" })).not.toBe(
      identity.volumeId,
    );

    const mover = new KopiaWorkspaceDataMover({
      workspaceRoot: "/tmp/agent-dock-workspace-data-mover-test",
      stateRoot: "/tmp/agent-dock-workspace-data-mover-state-test",
      kopiaBinary: "/does/not/run",
      kopiaConfigPath: "/tmp/agent-dock-workspace-data-mover-state-test/repository.config",
      kopiaCacheDirectory: "/tmp/agent-dock-workspace-data-mover-state-test/cache",
      repositoryPassword: "p".repeat(32),
      s3: {
        bucket: "unused",
        endpoint: "127.0.0.1:9000",
        region: "us-east-1",
        prefix: "unused",
        accessKey: "unused-access",
        secretAccessKey: "unused-secret",
        disableTls: true,
      },
    });
    await expect(mover.prepare({ ...identity, tenantId: "another-tenant" })).rejects.toMatchObject({
      code: "workspace_data_binding_invalid",
      retryable: false,
    });
    await expect(
      mover.materialize({
        ...identity,
        snapshotId: "snapshot-durable",
        path: "../tenant-b/secret.txt",
        expectedSha256: "a".repeat(64),
        maximumBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: "workspace_materialize_path_invalid", retryable: false });
    await expect(
      mover.snapshot({
        ...identity,
        activationId: "not-a-uuid",
        fencingToken: 1,
        bindingSha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "workspace_snapshot_fence_invalid", retryable: false });
  });
});
