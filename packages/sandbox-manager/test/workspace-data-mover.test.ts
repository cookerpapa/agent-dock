import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      initializeBaseline: vi.fn(async () => ({ gitBaselineCommit: "a".repeat(40) })),
      snapshot: vi.fn(async () => ({
        snapshotId: "snapshot-durable",
        gitBaselineCommit: "a".repeat(40),
        workspacePatch: { format: "unified_diff" as const, patch: "", truncated: false },
      })),
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
      await expect(client.initializeBaseline(identity)).resolves.toEqual({
        gitBaselineCommit: "a".repeat(40),
      });
      await expect(
        client.snapshot({
          ...identity,
          activationId: "10000000-0000-4000-8000-000000000001",
          fencingToken: 1,
          bindingSha256: "b".repeat(64),
        }),
      ).resolves.toEqual({
        snapshotId: "snapshot-durable",
        gitBaselineCommit: "a".repeat(40),
        workspacePatch: { format: "unified_diff", patch: "", truncated: false },
      });
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
      expect(mover.initializeBaseline).toHaveBeenCalledWith(identity);
    } finally {
      await server.close();
    }
  });

  it("streams materialized files larger than the control-message envelope", async () => {
    const bytes = Buffer.alloc(96 * 1_024, "agent-dock\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mover: WorkspaceDataMover = {
      checkHealth: vi.fn(async () => undefined),
      prepare: vi.fn(async () => ({ restored: true })),
      initializeBaseline: vi.fn(async () => ({ gitBaselineCommit: "a".repeat(40) })),
      snapshot: vi.fn(async () => ({
        snapshotId: "snapshot-large-file",
        gitBaselineCommit: "a".repeat(40),
        workspacePatch: { format: "unified_diff" as const, patch: "", truncated: false },
      })),
      materialize: vi.fn(async () => ({ bytes, sha256 })),
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
      const client = new HttpWorkspaceDataMover({
        baseUrl: address,
        serviceToken: TOKEN,
      });
      await expect(
        client.materialize({
          ...identity,
          snapshotId: "snapshot-large-file",
          path: "large-source.ts",
          expectedSha256: sha256,
          maximumBytes: bytes.byteLength,
        }),
      ).resolves.toEqual({ bytes, sha256 });
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

  it("keeps post-checkpoint writes for the same Session head and restores an explicit rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-data-mover-"));
    const workspaceRoot = join(root, "workspaces");
    const stateRoot = join(root, "state");
    const kopiaBinary = join(root, "fake-kopia.mjs");
    const envelopeBackup = join(root, "envelope.backup");
    await writeFile(
      kopiaBinary,
      `#!${process.execPath}
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "repository" && args[1] === "status") {
  process.stdout.write("{}\\n");
  process.exit(0);
}
if (args[0] === "snapshot" && args[1] === "create") {
  const source = args.at(-1);
  await rm(${JSON.stringify(envelopeBackup)}, { recursive: true, force: true });
  await cp(source, ${JSON.stringify(envelopeBackup)}, { recursive: true });
  process.stdout.write(JSON.stringify({ id: "snapshot-one" }) + "\\n");
  process.exit(0);
}
if (args[0] === "snapshot" && args[1] === "restore") {
  const source = args.at(-2);
  const target = args.at(-1);
  if (source.endsWith("/workspace/restored.txt")) {
    await writeFile(target, "materialized\\n");
    process.exit(0);
  }
  await mkdir(target, { recursive: true });
  await cp(${JSON.stringify(envelopeBackup)}, target, { recursive: true });
  process.exit(0);
}
process.exit(2);
`,
      { mode: 0o700 },
    );
    await chmod(kopiaBinary, 0o700);
    const mover = new KopiaWorkspaceDataMover({
      workspaceRoot,
      stateRoot,
      kopiaBinary,
      kopiaConfigPath: join(stateRoot, "repository.config"),
      kopiaCacheDirectory: join(stateRoot, "cache"),
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
    const volumeEnvelope = join(workspaceRoot, `agentdock-posix-${identity.volumeId}`);
    const volume = join(volumeEnvelope, "workspace");
    try {
      await expect(mover.prepare(identity)).resolves.toEqual({ restored: false });
      await expect(readdir(volume)).resolves.toEqual([]);
      await expect(
        readFile(join(volumeEnvelope, ".agent-dock-runtime/generation"), "utf8"),
      ).resolves.toMatch(/^[0-9a-f]{64}\n$/);
      await writeFile(join(volume, "committed.txt"), "committed\n");
      const baseline = await mover.initializeBaseline(identity);
      expect(baseline.gitBaselineCommit).toMatch(/^[0-9a-f]{40}$/);
      await expect(readdir(volume)).resolves.toEqual(["committed.txt"]);
      const checkpoint = await mover.snapshot({
        ...identity,
        activationId: "10000000-0000-4000-8000-000000000010",
        fencingToken: 7,
        bindingSha256: "a".repeat(64),
      });
      expect(checkpoint).toMatchObject({
        snapshotId: "snapshot-one",
        gitBaselineCommit: baseline.gitBaselineCommit,
        workspacePatch: { format: "unified_diff", patch: "", truncated: false },
      });

      await writeFile(join(volume, "committed.txt"), "changed after baseline\n");
      const changed = await mover.snapshot({
        ...identity,
        activationId: "10000000-0000-4000-8000-000000000010",
        fencingToken: 7,
        bindingSha256: "a".repeat(64),
      });
      expect(changed.workspacePatch.patch).toContain("-committed");
      expect(changed.workspacePatch.patch).toContain("+changed after baseline");

      await writeFile(join(volume, "background-write.txt"), "after checkpoint\n");
      await expect(
        mover.prepare({
          ...identity,
          snapshotId: "snapshot-one",
          gitBaselineCommit: baseline.gitBaselineCommit,
        }),
      ).resolves.toEqual({
        restored: false,
      });
      await expect(readFile(join(volume, "background-write.txt"), "utf8")).resolves.toBe(
        "after checkpoint\n",
      );

      for (const entry of await readdir(volumeEnvelope)) {
        await rm(join(volumeEnvelope, entry), { recursive: true, force: true });
      }
      await expect(
        mover.prepare({
          ...identity,
          snapshotId: "snapshot-one",
          gitBaselineCommit: baseline.gitBaselineCommit,
        }),
      ).resolves.toEqual({
        restored: true,
      });
      await expect(readFile(join(volume, "committed.txt"), "utf8")).resolves.toBe(
        "changed after baseline\n",
      );
      await expect(readdir(volume)).resolves.toEqual(["committed.txt"]);
      await expect(mover.initializeBaseline(identity)).resolves.toEqual(baseline);

      const materialized = Buffer.from("materialized\n");
      await expect(
        mover.materialize({
          ...identity,
          snapshotId: "snapshot-one",
          path: "restored.txt",
          expectedSha256: createHash("sha256").update(materialized).digest("hex"),
          maximumBytes: 1_024,
        }),
      ).resolves.toEqual({
        bytes: materialized,
        sha256: createHash("sha256").update(materialized).digest("hex"),
      });

      await expect(
        mover.prepare({
          ...identity,
          snapshotId: "snapshot-two",
          gitBaselineCommit: baseline.gitBaselineCommit,
        }),
      ).resolves.toEqual({
        restored: true,
      });
      await expect(readFile(join(volume, "committed.txt"), "utf8")).resolves.toBe(
        "changed after baseline\n",
      );
      await expect(readFile(join(volume, "background-write.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await rm(volume, { recursive: true, force: true });
      await symlink(root, volume, "dir");
      await expect(
        mover.snapshot({
          ...identity,
          activationId: "10000000-0000-4000-8000-000000000011",
          fencingToken: 8,
          bindingSha256: "b".repeat(64),
        }),
      ).rejects.toMatchObject({
        code: "workspace_volume_generation_invalid",
        retryable: false,
      });
    } finally {
      await mover.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
