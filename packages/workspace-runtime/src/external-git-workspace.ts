import { MAX_WORKSPACE_PATCH_BYTES, type WorkspacePatch } from "@pi-cloud/protocol";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAXIMUM_GIT_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_PATHSPEC_CHUNK_BYTES = 16 * 1_024;

export type ExternalGitWorkspace = Readonly<{
  workTree: string;
  gitDirectory: string;
}>;

function gitEnvironment(
  workspace: ExternalGitWorkspace,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: workspace.gitDirectory,
    GIT_TERMINAL_PROMPT: "0",
    GIT_WORK_TREE: workspace.workTree,
  };
}

function executeGit(
  workspace: ExternalGitWorkspace,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      {
        cwd: workspace.workTree,
        encoding: "utf8",
        env: gitEnvironment(workspace, environment),
        maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
      },
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

function pathspecChunks(paths: readonly string[]): readonly (readonly string[])[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const path of paths) {
    const bytes = Buffer.byteLength(path, "utf8") + 1;
    if (current.length > 0 && currentBytes + bytes > MAXIMUM_PATHSPEC_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function initializeExternalGitWorkspaceBaseline(
  workspace: ExternalGitWorkspace,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  await executeGit(workspace, ["init", "--quiet"], environment);
  await executeGit(workspace, ["config", "user.name", "PiCloud"], environment);
  await executeGit(workspace, ["config", "user.email", "platform@pi-cloud.invalid"], environment);
  await executeGit(workspace, ["config", "core.hooksPath", "/dev/null"], environment);
  await writeFile(join(workspace.gitDirectory, "info", "exclude"), "/.git/\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await executeGit(workspace, ["add", "--all", "--", "."], environment);
  await executeGit(
    workspace,
    ["commit", "--allow-empty", "--quiet", "-m", "PiCloud Workspace baseline"],
    environment,
  );
  return inspectExternalGitWorkspaceBaseline(workspace, environment);
}

export async function inspectExternalGitWorkspaceBaseline(
  workspace: ExternalGitWorkspace,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const commit = (
    await executeGit(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], environment)
  ).trim();
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new Error("External Workspace Git baseline was invalid");
  }
  return commit;
}

export async function collectExternalGitWorkspacePatch(
  workspace: ExternalGitWorkspace,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkspacePatch> {
  await inspectExternalGitWorkspaceBaseline(workspace, environment);
  const untracked = (
    await executeGit(
      workspace,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
      environment,
    )
  )
    .split("\0")
    .filter((path) => path.length > 0);
  for (const paths of pathspecChunks(untracked)) {
    await executeGit(workspace, ["add", "--intent-to-add", "--", ...paths], environment);
  }
  const diff = await executeGit(
    workspace,
    ["diff", "--no-ext-diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/", "--", "."],
    environment,
  );
  const bounded = boundedUtf8(diff, MAX_WORKSPACE_PATCH_BYTES);
  return {
    format: "unified_diff",
    patch: bounded.value,
    truncated: bounded.truncated,
  };
}
