import { MAX_WORKSPACE_PATCH_BYTES, type WorkspacePatch } from "@agent-dock/protocol";
import { execFile } from "node:child_process";

function executeGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 512 * 1_024 },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
  });
}

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        value: new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { value: "", truncated: true };
}

export async function collectGitWorkspacePatch(
  workspaceDirectory: string,
): Promise<WorkspacePatch> {
  const untracked = (
    await executeGit(["ls-files", "--others", "--exclude-standard", "-z", "--"], workspaceDirectory)
  )
    .split("\0")
    .filter((path) => path.length > 0);
  if (untracked.length > 0) {
    await executeGit(["add", "--intent-to-add", "--", ...untracked], workspaceDirectory);
  }
  const diff = await executeGit(
    ["diff", "--no-ext-diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/", "--"],
    workspaceDirectory,
  );
  const bounded = boundedUtf8(diff, MAX_WORKSPACE_PATCH_BYTES);
  return {
    format: "unified_diff",
    patch: bounded.value,
    truncated: bounded.truncated,
  };
}
