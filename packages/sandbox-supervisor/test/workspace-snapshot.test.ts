import {
  captureWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
  validateWorkspaceSnapshot,
} from "../src/index.ts";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded workspace snapshot", () => {
  it("restores regular files and executable bits without replacing the Git baseline", async () => {
    const source = await temporaryDirectory("agent-dock-workspace-source-");
    await mkdir(resolve(source, ".git"));
    await mkdir(resolve(source, "src"));
    await writeFile(resolve(source, "src/App.java"), "class App {}\n");
    await writeFile(resolve(source, "test.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(resolve(source, "test.sh"), 0o755);

    const snapshot = await captureWorkspaceSnapshot(source);
    validateWorkspaceSnapshot(snapshot);

    const target = await temporaryDirectory("agent-dock-workspace-target-");
    await mkdir(resolve(target, ".git"));
    await writeFile(resolve(target, ".git/HEAD"), "fixture-baseline\n");
    await writeFile(resolve(target, "stale.txt"), "remove me");
    await restoreWorkspaceSnapshot(target, snapshot);

    await expect(readFile(resolve(target, ".git/HEAD"), "utf8")).resolves.toBe(
      "fixture-baseline\n",
    );
    await expect(readFile(resolve(target, "src/App.java"), "utf8")).resolves.toBe("class App {}\n");
    await expect(readFile(resolve(target, "stale.txt"), "utf8")).rejects.toThrow();
    expect((await stat(resolve(target, "test.sh"))).mode & 0o111).not.toBe(0);
  });

  it("validates every path before mutating the destination", async () => {
    const malicious = Buffer.from(
      `${JSON.stringify({
        format: "agent-dock.workspace-manifest.v1",
        files: [
          {
            path: "../escape",
            executable: false,
            sizeBytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            content: "",
          },
        ],
      })}\n`,
    );
    const target = await temporaryDirectory("agent-dock-workspace-reject-");
    await writeFile(resolve(target, "keep.txt"), "still here");
    await expect(restoreWorkspaceSnapshot(target, malicious)).rejects.toThrow(/entry|path/i);
    await expect(readFile(resolve(target, "keep.txt"), "utf8")).resolves.toBe("still here");
  });
});
