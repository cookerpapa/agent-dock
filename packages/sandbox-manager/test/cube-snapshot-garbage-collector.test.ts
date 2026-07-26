import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CubeSnapshotGarbageCollector } from "../src/cube-snapshot-garbage-collector.ts";
import type {
  CubeSandboxRuntimeClient,
  CubeSandboxSnapshot,
} from "../src/cubesandbox-runtime-client.ts";

const DAY_MS = 24 * 60 * 60_000;
const LIVE = "snapshot-live";
const ORPHAN = "snapshot-orphan";
const LIVE_NAME = `adws-${"a".repeat(48)}`;
const ORPHAN_NAME = `adws-${"b".repeat(48)}`;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(scanId: string, referencedSnapshotIds: string[]) {
  return {
    managerProtocolVersion: 1 as const,
    type: "workspace.snapshot_gc" as const,
    requestId: scanId,
    scanId,
    referencedSnapshotIds,
  };
}

describe("Cube snapshot reference-aware garbage collection", () => {
  it("requires a complete inventory, two observations and a 24-hour grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-cube-gc-"));
    roots.push(root);
    const snapshots: CubeSandboxSnapshot[] = [
      { snapshotId: LIVE, names: [LIVE_NAME] },
      { snapshotId: ORPHAN, names: [ORPHAN_NAME] },
      { snapshotId: "base-template", names: ["agent-dock-tool-base"] },
    ];
    const deleted: string[] = [];
    const runtime = {
      async listSnapshots() {
        return snapshots.filter((snapshot) => !deleted.includes(snapshot.snapshotId));
      },
      async deleteSnapshot(snapshotId: string) {
        deleted.push(snapshotId);
      },
    } as unknown as CubeSandboxRuntimeClient;
    let now = 1_000;
    const statePath = join(root, "state/gc.json");
    const collector = new CubeSnapshotGarbageCollector({
      runtime,
      statePath,
      deletionEnabled: true,
      graceMs: DAY_MS,
      clock: () => now,
    });

    const first = await collector.reconcile(
      request("10000000-0000-4000-8000-000000000001", [LIVE]),
    );
    expect(first).toMatchObject({
      managedSnapshots: 2,
      referencedSnapshots: 1,
      candidates: 1,
      deletedSnapshotIds: [],
    });
    await expect(
      collector.reconcile(
        request("10000000-0000-4000-8000-000000000002", [LIVE, "missing-snapshot"]),
      ),
    ).rejects.toThrow("references a missing Cube snapshot");
    expect(deleted).toEqual([]);

    now += DAY_MS;
    const second = await collector.reconcile(
      request("10000000-0000-4000-8000-000000000003", [LIVE]),
    );
    expect(second.deletedSnapshotIds).toEqual([ORPHAN]);
    expect(deleted).toEqual([ORPHAN]);
    expect((await stat(statePath)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      format: "agent-dock.cube-snapshot-gc.v1",
      candidates: {},
      lastScanId: "10000000-0000-4000-8000-000000000003",
    });
  });

  it("never deletes while the production delete gate is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-cube-gc-dry-"));
    roots.push(root);
    const deleted: string[] = [];
    const runtime = {
      async listSnapshots() {
        return [{ snapshotId: ORPHAN, names: [ORPHAN_NAME] }];
      },
      async deleteSnapshot(snapshotId: string) {
        deleted.push(snapshotId);
      },
    } as unknown as CubeSandboxRuntimeClient;
    let now = 0;
    const collector = new CubeSnapshotGarbageCollector({
      runtime,
      statePath: join(root, "gc.json"),
      deletionEnabled: false,
      graceMs: DAY_MS,
      clock: () => now,
    });
    await collector.reconcile(request("10000000-0000-4000-8000-000000000011", []));
    now += DAY_MS;
    const result = await collector.reconcile(request("10000000-0000-4000-8000-000000000012", []));
    expect(result).toMatchObject({ candidates: 1, deletionEnabled: false });
    expect(deleted).toEqual([]);
  });
});
