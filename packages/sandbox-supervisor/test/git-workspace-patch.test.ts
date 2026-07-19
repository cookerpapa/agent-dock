import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGitWorkspacePatch } from "../src/index.ts";

const roots: string[] = [];

function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd: root, encoding: "utf8" }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cumulative Git workspace patch", () => {
  it("includes tracked edits, deletions, and untracked files without staging content", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-dock-workspace-patch-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "tracked.txt"), "before\n");
    await writeFile(join(root, "deleted.txt"), "remove me\n");
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.name", "AgentDock Test"]);
    await git(root, ["config", "user.email", "test@agent-dock.invalid"]);
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "--quiet", "-m", "baseline"]);

    await writeFile(join(root, "tracked.txt"), "after\n");
    await rm(join(root, "deleted.txt"));
    await writeFile(join(root, "src", "New.java"), "class New {}\n");
    const patch = await collectGitWorkspacePatch(root);

    expect(patch.truncated).toBe(false);
    expect(patch.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(patch.patch).toContain("-before");
    expect(patch.patch).toContain("+after");
    expect(patch.patch).toContain("deleted file mode");
    expect(patch.patch).toContain("diff --git a/src/New.java b/src/New.java");
    expect(patch.patch).toContain("new file mode");
    expect(patch.patch).toContain("+class New {}");
    expect(await git(root, ["diff", "--cached"])).toBe("");
  });
});
