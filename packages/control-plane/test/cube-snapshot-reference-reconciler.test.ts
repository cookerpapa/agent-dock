import type { Database } from "@agent-dock/database";
import { createCubeWorkspaceCheckpoint } from "@agent-dock/workspace-runtime";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { CubeSnapshotReferenceReconciler } from "../src/cube-snapshot-reference-reconciler.ts";

const TENANT = "tenant-cube-gc";
const SNAPSHOT_ID = "snapshot-referenced";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkpoint(): Uint8Array {
  return createCubeWorkspaceCheckpoint({
    snapshotId: SNAPSHOT_ID,
    sourceSandboxId: "sandbox-source",
    activationId: "10000000-0000-4000-8000-000000000001",
    tenantId: TENANT,
    workspaceId: "workspace-cube-gc",
    bindingSha256: "b".repeat(64),
    fencingToken: 3,
    imageRevision: "test-image",
    environmentSpecSha256: "e".repeat(64),
    files: [],
    authority: {
      keyVersion: 1,
      nonce: "a".repeat(16),
      ciphertext: "c".repeat(64),
      authTag: "d".repeat(22),
    },
  });
}

function databaseFor(bytes: Uint8Array): Kysely<Database> {
  const query = {
    select() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    async execute() {
      return [
        {
          id: "artifact-1",
          tenant_id: TENANT,
          object_key: "workspace/1",
          sha256: sha256(bytes),
          size_bytes: bytes.byteLength,
        },
      ];
    },
  };
  return {
    selectFrom() {
      return query;
    },
  } as unknown as Kysely<Database>;
}

describe("Cube snapshot reference reconciliation", () => {
  it("sends only integrity-checked Cube references to the destructive boundary", async () => {
    const bytes = checkpoint();
    const reconcileSnapshots = vi.fn(async (request) => ({
      managerProtocolVersion: 1 as const,
      type: "workspace.snapshot_gc_reconciled" as const,
      requestId: request.requestId,
      scanId: request.scanId,
      managedSnapshots: 1,
      referencedSnapshots: 1,
      candidates: 0,
      deletedSnapshotIds: [],
      deletionEnabled: true,
    }));
    const reconciler = new CubeSnapshotReferenceReconciler({
      database: databaseFor(bytes),
      objectStore: { get: async () => bytes },
      client: { reconcileSnapshots },
      idGenerator: (() => {
        const ids = [
          "10000000-0000-4000-8000-000000000011",
          "10000000-0000-4000-8000-000000000012",
        ];
        return () => ids.shift()!;
      })(),
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ referencedSnapshots: 1 });
    expect(reconcileSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({ referencedSnapshotIds: [SNAPSHOT_ID] }),
    );
  });

  it("fails closed before contacting Cube when an object is corrupt", async () => {
    const bytes = checkpoint();
    const reconcileSnapshots = vi.fn();
    const reconciler = new CubeSnapshotReferenceReconciler({
      database: databaseFor(bytes),
      objectStore: { get: async () => Buffer.from("corrupt") },
      client: { reconcileSnapshots },
    });
    await expect(reconciler.reconcile()).rejects.toThrow("immutable integrity check");
    expect(reconcileSnapshots).not.toHaveBeenCalled();
  });
});
