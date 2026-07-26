import type { Database } from "@agent-dock/database";
import { MAX_WORKSPACE_SNAPSHOT_BYTES } from "@agent-dock/protocol";
import type { SandboxManagerClient } from "@agent-dock/sandbox-manager/client";
import { parseCubeWorkspaceCheckpoint } from "@agent-dock/workspace-runtime";
import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { CheckpointObjectStore } from "./checkpoint-store.ts";

const MAXIMUM_REFERENCED_SNAPSHOTS = 10_000;
const LOAD_CONCURRENCY = 8;

export type CubeSnapshotReferenceReconcilerOptions = Readonly<{
  database: Kysely<Database>;
  objectStore: Pick<CheckpointObjectStore, "get">;
  client: Pick<SandboxManagerClient, "reconcileSnapshots">;
  idGenerator?: () => string;
}>;

export type CubeSnapshotReferenceReconcileResult = Awaited<
  ReturnType<SandboxManagerClient["reconcileSnapshots"]>
>;

function artifactSize(value: string | number | bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WORKSPACE_SNAPSHOT_BYTES) {
    throw new Error("Workspace snapshot artifact size is invalid");
  }
  return parsed;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class CubeSnapshotReferenceReconciler {
  readonly #database: Kysely<Database>;
  readonly #objectStore: Pick<CheckpointObjectStore, "get">;
  readonly #client: Pick<SandboxManagerClient, "reconcileSnapshots">;
  readonly #idGenerator: () => string;
  #active: Promise<CubeSnapshotReferenceReconcileResult> | undefined;

  constructor(options: CubeSnapshotReferenceReconcilerOptions) {
    this.#database = options.database;
    this.#objectStore = options.objectStore;
    this.#client = options.client;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  reconcile(): Promise<CubeSnapshotReferenceReconcileResult> {
    this.#active ??= this.#run().finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }

  async #run(): Promise<CubeSnapshotReferenceReconcileResult> {
    const artifacts = await this.#database
      .selectFrom("artifacts")
      .select(["id", "tenant_id", "object_key", "sha256", "size_bytes"])
      .where("kind", "=", "workspace_snapshot")
      .orderBy("id", "asc")
      .execute();
    const references = new Set<string>();
    for (let offset = 0; offset < artifacts.length; offset += LOAD_CONCURRENCY) {
      const batch = artifacts.slice(offset, offset + LOAD_CONCURRENCY);
      const snapshots = await Promise.all(
        batch.map(async (artifact) => {
          const expectedSize = artifactSize(artifact.size_bytes);
          const bytes = await this.#objectStore.get(artifact.object_key);
          if (bytes.byteLength !== expectedSize || sha256(bytes) !== artifact.sha256) {
            throw new Error("Workspace snapshot artifact failed its immutable integrity check");
          }
          const checkpoint = parseCubeWorkspaceCheckpoint(bytes);
          if (checkpoint !== undefined && checkpoint.tenantId !== artifact.tenant_id) {
            throw new Error("Cube Workspace checkpoint tenant binding is invalid");
          }
          return checkpoint;
        }),
      );
      for (const checkpoint of snapshots) {
        if (checkpoint === undefined) continue;
        references.add(checkpoint.snapshotId);
        if (references.size > MAXIMUM_REFERENCED_SNAPSHOTS) {
          throw new Error(
            "Cube snapshot reference count exceeds the bounded garbage-collection protocol",
          );
        }
      }
    }
    const requestId = this.#idGenerator();
    const scanId = this.#idGenerator();
    return this.#client.reconcileSnapshots({
      managerProtocolVersion: 1,
      type: "workspace.snapshot_gc",
      requestId,
      scanId,
      referencedSnapshotIds: [...references].sort(),
    });
  }
}
