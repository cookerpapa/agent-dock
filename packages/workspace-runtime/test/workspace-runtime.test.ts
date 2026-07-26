import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceSnapshot,
  captureCubeWorkspaceIndex,
  collectGitWorkspacePatch,
  createCubeWorkspaceCheckpoint,
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  createWorkspaceSnapshot,
  mergeWorkspaceSnapshots,
  parseWorkspaceSnapshot,
  parseCubeWorkspaceCheckpoint,
  restoreWorkspaceSnapshot,
  workspaceSnapshotMetadata,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd: root, encoding: "utf8" }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("shared workspace runtime", () => {
  it("round-trips a bounded snapshot envelope without replacing the Git baseline", async () => {
    const source = await temporaryDirectory("agent-dock-workspace-runtime-source-");
    await mkdir(resolve(source, ".git"));
    await mkdir(resolve(source, "src"));
    await writeFile(resolve(source, "src/App.java"), "class App {}\n");
    await writeFile(resolve(source, "test.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(resolve(source, "test.sh"), 0o755);

    const snapshot = await captureWorkspaceSnapshot(source);
    const restoredEnvelope = decodeWorkspaceSnapshotBlob(encodeWorkspaceSnapshotBlob(snapshot));
    expect(Buffer.from(restoredEnvelope)).toEqual(Buffer.from(snapshot));

    const target = await temporaryDirectory("agent-dock-workspace-runtime-target-");
    await mkdir(resolve(target, ".git"));
    await writeFile(resolve(target, ".git/HEAD"), "fixture-baseline\n");
    await writeFile(resolve(target, "stale.txt"), "remove me");
    await restoreWorkspaceSnapshot(target, restoredEnvelope);

    await expect(readFile(resolve(target, ".git/HEAD"), "utf8")).resolves.toBe(
      "fixture-baseline\n",
    );
    await expect(readFile(resolve(target, "src/App.java"), "utf8")).resolves.toBe("class App {}\n");
    await expect(readFile(resolve(target, "stale.txt"), "utf8")).rejects.toThrow();
    expect((await stat(resolve(target, "test.sh"))).mode & 0o111).not.toBe(0);
  });

  it("collects tracked edits, deletions, and untracked files without staging content", async () => {
    const root = await temporaryDirectory("agent-dock-workspace-runtime-patch-");
    await mkdir(resolve(root, "src"));
    await writeFile(resolve(root, "tracked.txt"), "before\n");
    await writeFile(resolve(root, "deleted.txt"), "remove me\n");
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.name", "AgentDock Test"]);
    await git(root, ["config", "user.email", "test@agent-dock.invalid"]);
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "--quiet", "-m", "baseline"]);

    await writeFile(resolve(root, "tracked.txt"), "after\n");
    await rm(resolve(root, "deleted.txt"));
    await writeFile(resolve(root, "src/New.java"), "class New {}\n");
    const patch = await collectGitWorkspacePatch(root);

    expect(patch.truncated).toBe(false);
    expect(patch.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(patch.patch).toContain("deleted file mode");
    expect(patch.patch).toContain("diff --git a/src/New.java b/src/New.java");
    expect(await git(root, ["diff", "--cached"])).toBe("");
  });

  it("merges exact repository snapshots beneath disjoint normalized roots", () => {
    const merged = mergeWorkspaceSnapshots([
      {
        root: "frontend",
        snapshot: createWorkspaceSnapshot([
          { path: "package.json", executable: false, content: Buffer.from("{}\n") },
        ]),
      },
      {
        root: "shared-lib",
        snapshot: createWorkspaceSnapshot([
          {
            path: "src/Library.java",
            executable: false,
            content: Buffer.from("class Library {}\n"),
          },
        ]),
      },
    ]);
    expect(parseWorkspaceSnapshot(merged).map((file) => file.path)).toEqual([
      "frontend/package.json",
      "shared-lib/src/Library.java",
    ]);
    expect(() =>
      mergeWorkspaceSnapshots([
        { root: "frontend", snapshot: createWorkspaceSnapshot([]) },
        { root: "frontend", snapshot: createWorkspaceSnapshot([]) },
      ]),
    ).toThrow(/root/);
    expect(() =>
      mergeWorkspaceSnapshots([
        { root: ".", snapshot: createWorkspaceSnapshot([]) },
        { root: "backend", snapshot: createWorkspaceSnapshot([]) },
      ]),
    ).toThrow(/root/);
  });

  it("indexes a large Cube Workspace without embedding file bytes or dropping nested Git state", async () => {
    const root = await temporaryDirectory("agent-dock-cube-workspace-index-");
    await mkdir(resolve(root, ".git"));
    await writeFile(resolve(root, ".git/HEAD"), "ref: refs/heads/main\n");
    await mkdir(resolve(root, "nested/.git"), { recursive: true });
    await writeFile(resolve(root, "nested/.git/config"), "[core]\n");
    await mkdir(resolve(root, "src"));
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        writeFile(resolve(root, `src/file-${String(index).padStart(3, "0")}.txt`), `${index}\n`),
      ),
    );

    const files = await captureCubeWorkspaceIndex(root);
    expect(files).toHaveLength(601);
    expect(files[0]?.path).toBe("nested/.git/config");
    expect(files.some((file) => file.path === ".git/HEAD")).toBe(false);
    const encoded = createCubeWorkspaceCheckpoint({
      snapshotId: "cube-snapshot-large",
      sourceSandboxId: "cube-sandbox-large",
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-large",
      workspaceId: "workspace-large",
      bindingSha256: "a".repeat(64),
      fencingToken: 7,
      imageRevision: "development",
      environmentSpecSha256: "b".repeat(64),
      files,
      authority: {
        keyVersion: 1,
        nonce: "c".repeat(16),
        ciphertext: "d".repeat(64),
        authTag: "e".repeat(22),
      },
    });
    const parsed = parseCubeWorkspaceCheckpoint(encoded);
    expect(parsed?.files).toHaveLength(601);
    expect(workspaceSnapshotMetadata(encoded)).toEqual(parsed?.files);
    expect(encoded.byteLength).toBeLessThan(256 * 1_024);
    expect(Buffer.from(encoded).toString("utf8")).not.toContain(
      Buffer.from("599\n").toString("base64"),
    );
    expect(() => parseWorkspaceSnapshot(encoded)).toThrow(/portable file bytes/);
  });

  it("rejects symlinks from the Cube checkpoint index", async () => {
    const root = await temporaryDirectory("agent-dock-cube-workspace-link-");
    await writeFile(resolve(root, "target.txt"), "target\n");
    await symlink("target.txt", resolve(root, "link.txt"));
    await expect(captureCubeWorkspaceIndex(root)).rejects.toThrow(/link or special file/);
  });
});
