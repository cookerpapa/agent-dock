import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceSnapshot,
  captureWorkspaceIndex,
  collectGitWorkspacePatch,
  createKopiaWorkspaceCheckpoint,
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  createWorkspaceSnapshot,
  mergeWorkspaceSnapshots,
  parseWorkspaceSnapshot,
  parseKopiaWorkspaceCheckpoint,
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
    await mkdir(resolve(target, ".agent-dock-runtime"));
    await writeFile(resolve(target, ".agent-dock-runtime/generation"), `${"a".repeat(64)}\n`);
    await writeFile(resolve(target, "stale.txt"), "remove me");
    await restoreWorkspaceSnapshot(target, restoredEnvelope);

    await expect(readFile(resolve(target, ".git/HEAD"), "utf8")).resolves.toBe(
      "fixture-baseline\n",
    );
    await expect(readFile(resolve(target, "src/App.java"), "utf8")).resolves.toBe("class App {}\n");
    await expect(readFile(resolve(target, ".agent-dock-runtime/generation"), "utf8")).resolves.toBe(
      `${"a".repeat(64)}\n`,
    );
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
    await mkdir(resolve(root, ".agent-dock-runtime"));
    await writeFile(resolve(root, ".agent-dock-runtime/generation"), `${"a".repeat(64)}\n`);
    const patch = await collectGitWorkspacePatch(root);

    expect(patch.truncated).toBe(false);
    expect(patch.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(patch.patch).toContain("deleted file mode");
    expect(patch.patch).toContain("diff --git a/src/New.java b/src/New.java");
    expect(patch.patch).not.toContain(".agent-dock-runtime");
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

  it("indexes a large Workspace without embedding file bytes or dropping nested Git state", async () => {
    const root = await temporaryDirectory("agent-dock-cube-workspace-index-");
    await mkdir(resolve(root, ".git"));
    await writeFile(resolve(root, ".git/HEAD"), "ref: refs/heads/main\n");
    await mkdir(resolve(root, ".agent-dock-runtime"));
    await writeFile(resolve(root, ".agent-dock-runtime/generation"), `${"a".repeat(64)}\n`);
    await mkdir(resolve(root, "nested/.git"), { recursive: true });
    await writeFile(resolve(root, "nested/.git/config"), "[core]\n");
    await mkdir(resolve(root, "src"));
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        writeFile(resolve(root, `src/file-${String(index).padStart(3, "0")}.txt`), `${index}\n`),
      ),
    );

    const index = await captureWorkspaceIndex(root);
    const files = index.files;
    expect(index.portable).toBe(true);
    expect(files).toHaveLength(601);
    expect(files[0]?.path).toBe("nested/.git/config");
    expect(files.some((file) => file.path === ".git/HEAD")).toBe(false);
    expect(files.some((file) => file.path.startsWith(".agent-dock-runtime/"))).toBe(false);
  });

  it("indexes symlinks without following them", async () => {
    const root = await temporaryDirectory("agent-dock-cube-workspace-link-");
    await writeFile(resolve(root, "target.txt"), "target\n");
    await symlink("target.txt", resolve(root, "link.txt"));
    const index = await captureWorkspaceIndex(root);
    expect(index.portable).toBe(false);
    expect(index.files.map((file) => file.path)).toEqual(["link.txt", "target.txt"]);
    const link = index.files[0];
    const target = index.files[1];
    expect(link).toMatchObject({
      path: "link.txt",
      executable: false,
      sizeBytes: Buffer.byteLength("target.txt"),
    });
    expect(link?.sha256).not.toBe(target?.sha256);
  });

  it("round-trips a Workspace-portable Kopia checkpoint without embedding file bytes", () => {
    const checkpoint = createKopiaWorkspaceCheckpoint({
      snapshotId: "k1234567890abcdef",
      volumeId: `adw-${"a".repeat(48)}`,
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-kopia",
      workspaceId: "workspace-kopia",
      sourceSessionId: "session-kopia",
      bindingSha256: "b".repeat(64),
      fencingToken: 9,
      imageRevision: "development",
      environmentSpecSha256: "c".repeat(64),
      files: [
        {
          path: "src/result.txt",
          executable: false,
          sizeBytes: 7,
          sha256: "d".repeat(64),
        },
      ],
      recipeCommands: [],
    });
    expect(parseKopiaWorkspaceCheckpoint(checkpoint)).toMatchObject({
      snapshotId: "k1234567890abcdef",
      tenantId: "tenant-kopia",
      workspaceId: "workspace-kopia",
      sourceSessionId: "session-kopia",
      fencingToken: 9,
      totalSizeBytes: 7,
    });
    expect(workspaceSnapshotMetadata(checkpoint)).toEqual([
      expect.objectContaining({ path: "src/result.txt", sizeBytes: 7 }),
    ]);
    expect(() => parseWorkspaceSnapshot(checkpoint)).toThrow(/portable file bytes/);

    const withUnexpectedField = JSON.parse(Buffer.from(checkpoint).toString("utf8")) as Record<
      string,
      unknown
    >;
    withUnexpectedField.untrusted = true;
    expect(() =>
      parseKopiaWorkspaceCheckpoint(Buffer.from(JSON.stringify(withUnexpectedField))),
    ).toThrow(/shape/);
  });
});
