import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpWorkspaceVolumeGateway,
  PersistentVolumeWorkspaceVolumeGateway,
  WorkspaceVolumeGatewayServer,
  workspaceVolumeId,
  type WorkspaceVolumeGateway,
} from "../src/index.ts";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-cloud-volume-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function identity(sessionId: string) {
  const tenantId = "tenant-volume-test";
  const workspaceId = "workspace-volume-test";
  return {
    tenantId,
    workspaceId,
    sessionId,
    volumeId: workspaceVolumeId({ tenantId, workspaceId }),
  };
}

describe("PersistentVolumeWorkspaceVolumeGateway", () => {
  it("binds one durable volume to a Workspace across Sessions", () => {
    expect(identity("session-a").volumeId).toBe(identity("session-b").volumeId);
  });

  it("reattaches files without copying a per-Run Workspace snapshot", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-a");

    await expect(mover.prepare(first)).resolves.toEqual({ attached: false });
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    const workspace = join(volumeRoot, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "answer.txt"), "one\n");
    await mover.initializeBaseline(first);
    await writeFile(join(workspace, "src", "answer.txt"), "two\n");

    const captured = await mover.snapshot({
      ...first,
      activationId: randomUUID(),
      fencingToken: 1,
      bindingSha256: "a".repeat(64),
    });
    expect(captured.volumeRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.files).toEqual([
      expect.objectContaining({ path: "src/answer.txt", sizeBytes: 4 }),
    ]);
    expect(captured.workspacePatch.patch).toContain("two");

    const replacement = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const second = identity("session-b");
    await expect(replacement.prepare(second)).resolves.toEqual({ attached: true });
    const expectedSha256 = createHash("sha256").update("two\n").digest("hex");
    await expect(
      replacement.materialize({
        ...second,
        path: "src/answer.txt",
        expectedSha256,
        maximumBytes: 64,
      }),
    ).resolves.toMatchObject({ sha256: expectedSha256 });
    await expect(readFile(join(workspace, "src", "answer.txt"), "utf8")).resolves.toBe("two\n");
  });

  it("binds the empty workspace directory created by the Cube Volume Plugin", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-plugin-created");
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    await mkdir(join(volumeRoot, "workspace"), { recursive: true, mode: 0o700 });

    await expect(mover.prepare(first)).resolves.toEqual({ attached: false });
    await expect(mover.prepare(first)).resolves.toEqual({ attached: true });
  });

  it("creates an idempotent isolated Volume copy that no longer follows the parent", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const source = identity("session-parent");
    await mover.prepare(source);
    const sourceRoot = join(workspaceRoot, `picloud-posix-${source.volumeId}`, "workspace");
    await writeFile(join(sourceRoot, "answer.txt"), "parent-v1\n");
    await mover.initializeBaseline(source);
    const captured = await mover.snapshot({
      ...source,
      activationId: randomUUID(),
      fencingToken: 1,
      bindingSha256: "a".repeat(64),
    });
    const target = {
      tenantId: source.tenantId,
      workspaceId: "workspace-volume-isolated",
      sessionId: "session-child",
      volumeId: workspaceVolumeId({
        tenantId: source.tenantId,
        workspaceId: "workspace-volume-isolated",
      }),
    };
    await mkdir(join(workspaceRoot, `picloud-posix-${target.volumeId}`, "workspace"), {
      recursive: true,
    });
    const request = {
      tenantId: source.tenantId,
      sourceWorkspaceId: source.workspaceId,
      sourceSessionId: source.sessionId,
      sourceVolumeId: source.volumeId,
      expectedSourceRevision: captured.volumeRevision,
      targetWorkspaceId: target.workspaceId,
      targetSessionId: target.sessionId,
      targetVolumeId: target.volumeId,
    };
    const first = await mover.fork(request);
    await writeFile(join(sourceRoot, "answer.txt"), "parent-v2\n");
    await expect(mover.fork(request)).resolves.toEqual(first);
    await expect(
      readFile(
        join(workspaceRoot, `picloud-posix-${target.volumeId}`, "workspace", "answer.txt"),
        "utf8",
      ),
    ).resolves.toBe("parent-v1\n");
  });

  it("rejects an unbound Cube workspace that already contains user bytes", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-plugin-nonempty");
    const workspace = join(workspaceRoot, `picloud-posix-${first.volumeId}`, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "untrusted.txt"), "not pristine\n");

    await expect(mover.prepare(first)).rejects.toMatchObject({
      code: "workspace_volume_binding_invalid",
    });
  });

  it("rejects a volume identity from another tenant", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-a");
    await mover.prepare(first);
    await expect(mover.prepare({ ...first, tenantId: "tenant-other" })).rejects.toMatchObject({
      code: "workspace_data_binding_invalid",
    });
  });

  it("deletes only the persistently bound Workspace volume and is idempotent", async () => {
    const workspaceRoot = await root();
    const mover = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot });
    const first = identity("session-delete");
    await mover.prepare(first);
    const volumeRoot = join(workspaceRoot, `picloud-posix-${first.volumeId}`);
    await writeFile(join(volumeRoot, "workspace", "private.txt"), "delete me\n");

    await expect(mover.delete(first)).resolves.toEqual({ deleted: true });
    await expect(lstat(volumeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(mover.delete(first)).resolves.toEqual({ deleted: false });
  });
});

describe("HttpWorkspaceVolumeGateway", () => {
  it("transports a bounded large Workspace index without copying file bytes", async () => {
    const files = Array.from({ length: 3_500 }, (_, index) => ({
      path: `src/generated/file-${index.toString().padStart(5, "0")}.ts`,
      executable: false,
      sizeBytes: 16,
      sha256: index.toString(16).padStart(64, "0"),
    }));
    const gateway: WorkspaceVolumeGateway = {
      async checkHealth() {},
      async prepare() {
        return { attached: true };
      },
      async initializeBaseline() {
        return { gitBaselineCommit: "1".repeat(40) };
      },
      async snapshot() {
        return {
          volumeRevision: "2".repeat(64),
          gitBaselineCommit: "1".repeat(40),
          workspacePatch: { format: "unified_diff" as const, patch: "", truncated: false },
          files,
        };
      },
      async fork() {
        return {
          sourceRevision: "2".repeat(64),
          volumeRevision: "3".repeat(64),
          gitBaselineCommit: "1".repeat(40),
          files,
        };
      },
      async materialize() {
        return { bytes: new Uint8Array(), sha256: createHash("sha256").digest("hex") };
      },
      async delete() {
        return { deleted: true };
      },
      async close() {},
    };
    const serviceToken = "v".repeat(48);
    const server = new WorkspaceVolumeGatewayServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken,
      gateway,
    });
    const address = await server.listen();
    const client = new HttpWorkspaceVolumeGateway({ baseUrl: address, serviceToken });
    try {
      const snapshot = await client.snapshot({
        ...identity("session-large-index"),
        activationId: randomUUID(),
        fencingToken: 1,
        bindingSha256: "3".repeat(64),
      });
      expect(snapshot.files).toHaveLength(files.length);
      await expect(client.delete(identity("session-large-index"))).resolves.toEqual({
        deleted: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
