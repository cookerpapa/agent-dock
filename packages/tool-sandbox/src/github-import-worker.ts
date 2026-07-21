import {
  parseGitHubWorkspaceImportRequest,
  type GitHubWorkspaceImportFailure,
  type GitHubWorkspaceImportOutput,
  type GitHubWorkspaceImportRequest,
} from "@agent-dock/protocol";
import {
  WorkspaceRuntimeError,
  captureWorkspaceSnapshot,
  encodeWorkspaceSnapshotBlob,
} from "@agent-dock/workspace-runtime";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const WORKSPACE_DIRECTORY = "/workspace";
const GIT_HOME = "/tmp/agent-dock-git-home";
const GIT_TIMEOUT_MS = 90_000;
const GIT_FETCH_TIMEOUT_MS = 45_000;
const GIT_FETCH_MAXIMUM_ATTEMPTS = 3;

class WorkspaceImportWorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "WorkspaceImportWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function runGit(args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      {
        cwd: WORKSPACE_DIRECTORY,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 128 * 1_024,
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          HOME: GIT_HOME,
          GIT_ASKPASS: "/bin/false",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
        },
      },
      (error, stdout) => {
        if (error) {
          process.stderr.write(
            `${JSON.stringify({
              event: "repository_git_failed",
              code: typeof error.code === "number" ? error.code : null,
              killed: error.killed === true,
              signal: error.signal ?? null,
            })}\n`,
          );
          rejectPromise(
            new WorkspaceImportWorkerError(
              "repository_git_failed",
              "Public GitHub repository import failed",
              true,
            ),
          );
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

async function fetchExactCommit(args: readonly string[]): Promise<void> {
  let lastFailure: WorkspaceImportWorkerError | undefined;
  for (let attempt = 1; attempt <= GIT_FETCH_MAXIMUM_ATTEMPTS; attempt += 1) {
    try {
      await runGit(args, GIT_FETCH_TIMEOUT_MS);
      return;
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceImportWorkerError) || !error.retryable) throw error;
      lastFailure = error;
      if (attempt < GIT_FETCH_MAXIMUM_ATTEMPTS) {
        await delay(250 * attempt);
      }
    }
  }
  throw lastFailure!;
}

const SAFE_GIT_CONFIG = [
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "http.version=HTTP/1.1",
  "-c",
  "http.lowSpeedLimit=1024",
  "-c",
  "http.lowSpeedTime=20",
  "-c",
  "http.followRedirects=false",
  "-c",
  "credential.helper=",
  "-c",
  "safe.directory=/workspace",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.symlinks=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
] as const;

async function importRepository(request: GitHubWorkspaceImportRequest): Promise<Uint8Array> {
  const url = `https://github.com/${request.source.repository}.git`;
  await mkdir(GIT_HOME, { recursive: true, mode: 0o700 });
  await runGit([...SAFE_GIT_CONFIG, "init", "--quiet", "."]);
  await fetchExactCommit([
    ...SAFE_GIT_CONFIG,
    "fetch",
    "--depth=1",
    "--no-tags",
    "--filter=blob:limit=524288",
    url,
    request.source.commitSha,
  ]);
  await runGit([...SAFE_GIT_CONFIG, "checkout", "--detach", "--force", "FETCH_HEAD"]);
  const head = (await runGit([...SAFE_GIT_CONFIG, "rev-parse", "HEAD"])).trim();
  if (head !== request.source.commitSha) {
    throw new WorkspaceImportWorkerError(
      "repository_commit_mismatch",
      "Imported repository commit did not match the request",
      false,
    );
  }
  await rm(`${WORKSPACE_DIRECTORY}/.git`, { recursive: true, force: true });
  try {
    return await captureWorkspaceSnapshot(WORKSPACE_DIRECTORY);
  } catch (error: unknown) {
    if (error instanceof WorkspaceRuntimeError) {
      throw new WorkspaceImportWorkerError(
        "repository_snapshot_unsupported",
        "Repository is outside the supported workspace limits",
        false,
      );
    }
    throw error;
  }
}

function writeOutput(output: GitHubWorkspaceImportOutput): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.write(`${JSON.stringify(output)}\n`, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let request: GitHubWorkspaceImportRequest | undefined;
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new WorkspaceImportWorkerError(
          "repository_import_protocol_error",
          "Repository importer input was invalid",
          false,
        );
      }
      request = parseGitHubWorkspaceImportRequest(parsed);
      // Kubernetes attach keeps the stdin channel open for the lifetime of the
      // Pod. A complete first protocol frame is authoritative, so begin the
      // bounded import immediately instead of waiting for EOF from the remote
      // attach transport.
      lines.close();
      break;
    }
    if (request === undefined) {
      throw new WorkspaceImportWorkerError(
        "repository_import_protocol_error",
        "Repository importer input was missing",
        false,
      );
    }
    const snapshot = await importRepository(request);
    await writeOutput({
      workspaceImportProtocolVersion: 1,
      type: "workspace.import.result",
      importId: request.importId,
      snapshot: encodeWorkspaceSnapshotBlob(snapshot),
    });
  } catch (error: unknown) {
    if (request === undefined) throw error;
    const failure: GitHubWorkspaceImportFailure = {
      workspaceImportProtocolVersion: 1,
      type: "workspace.import.failed",
      importId: request.importId,
      code:
        error instanceof WorkspaceImportWorkerError
          ? error.code
          : "repository_import_worker_failed",
      message:
        error instanceof WorkspaceImportWorkerError
          ? error.message
          : "Repository import worker failed",
      retryable: error instanceof WorkspaceImportWorkerError ? error.retryable : true,
    };
    await writeOutput(failure).catch(() => undefined);
    process.exitCode = 1;
  }
}

await main();
