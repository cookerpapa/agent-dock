import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const profiles = [
  {
    path: "deploy/enterprise/stage1-8-cells.yaml",
    cells: 8,
    maximumRunSlots: 2_048,
    maximumWorkersPerCell: 64,
  },
  {
    path: "deploy/enterprise/stage2-32-cells.yaml",
    cells: 32,
    maximumRunSlots: 10_240,
    maximumWorkersPerCell: 80,
  },
];

function execute(args) {
  const result = spawnSync("node", ["scripts/enterprise-cells.mjs", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

for (const profile of profiles) {
  const description = JSON.parse(execute(["describe", "--profile", profile.path]));
  assert.equal(description.cells, profile.cells);
  assert.equal(description.maximumRunSlots, profile.maximumRunSlots);
  assert.equal(description.maximumWorkersPerCell, profile.maximumWorkersPerCell);
  assert.ok(description.maximumSandboxAdmissions >= description.maximumRunSlots);

  const manifest = execute(["render", "--profile", profile.path]);
  assert.equal((manifest.match(/^kind: ScaledObject$/gmu) ?? []).length, profile.cells);
  assert.equal(
    (manifest.match(/^kind: Deployment\nmetadata:\n  name: agent-dock-control-plane$/gmu) ?? [])
      .length,
    1,
  );
  assert.equal(
    (manifest.match(/^kind: Deployment\nmetadata:\n  name: agent-dock-event-gateway$/gmu) ?? [])
      .length,
    1,
  );
  const workerPools = new Set(
    [...manifest.matchAll(/agent-dock\.io\/worker-pool: "(cell-\d{4}-v1)"/gu)].map(
      (match) => match[1],
    ),
  );
  assert.equal(workerPools.size, profile.cells);
  for (let index = 1; index <= profile.cells; index += 1) {
    const suffix = String(index).padStart(4, "0");
    assert.match(manifest, new RegExp(`agent-dock-pi-runs-cell-${suffix}-v1`, "u"));
    assert.match(manifest, new RegExp(`agent-dock-cell-${suffix}\\.svc\\.cluster\\.local`, "u"));
  }
}

process.stdout.write("enterprise_cells_check_passed\n");
