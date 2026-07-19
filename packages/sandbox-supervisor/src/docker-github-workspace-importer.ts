import {
  parseGitHubWorkspaceImportOutput,
  type GitHubRepositorySource,
  type GitHubWorkspaceImportRequest,
} from "@agent-dock/protocol";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { decodeWorkspaceSnapshot } from "./sandbox-checkpoint.ts";

const MAX_STDOUT_BYTES = 3 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 4_096;

export type DockerGitHubWorkspaceImporterOptions = {
  image: string;
  network: string;
  dockerCommand?: string;
  timeoutMs?: number;
  idGenerator?: () => string;
};

export class GitHubWorkspaceImporterError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "GitHubWorkspaceImporterError";
    this.code = code;
    this.retryable = retryable;
  }
}

function bounded(value: string, name: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function dockerNetwork(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || value === "none") {
    throw new TypeError("Repository importer Docker network is invalid");
  }
  return value;
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new TypeError("Repository importer timeout is invalid");
  }
  return value;
}

export function buildDockerGitHubWorkspaceImportArguments(
  image: string,
  network: string,
  containerName: string,
  importId: string,
): readonly string[] {
  bounded(image, "Repository importer image", 1_024);
  dockerNetwork(network);
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(containerName)) {
    throw new TypeError("Repository importer container name is invalid");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(importId)) {
    throw new TypeError("Repository import ID is invalid");
  }
  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    containerName,
    "--label",
    "agent-dock.workspace-import=true",
    "--label",
    `agent-dock.workspace-import-id=${importId}`,
    "--user",
    "1000:1000",
    "--read-only",
    "--network",
    network,
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "96",
    "--memory",
    "384m",
    "--cpus",
    "0.75",
    "--ulimit",
    "nofile=512:512",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=1000,gid=1000",
    "--tmpfs",
    "/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
    "--workdir",
    "/workspace",
    "--stop-timeout",
    "5",
    "--entrypoint",
    "node",
    image,
    "/app/packages/sandbox-supervisor/src/github-workspace-import-worker.ts",
  ];
}

function sendRequest(child: ChildProcessWithoutNullStreams, request: unknown): void {
  if (!child.stdin.write(`${JSON.stringify(request)}\n`)) {
    throw new GitHubWorkspaceImporterError(
      "repository_import_backpressure",
      "Repository importer input was backpressured",
      true,
    );
  }
  child.stdin.end();
}

function executeDocker(
  dockerCommand: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolvePromise) => {
    execFile(
      dockerCommand,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 128 * 1_024 },
      (error, stdout, stderr) => {
        resolvePromise({ stdout, stderr, error });
      },
    );
  });
}

export function isMissingDockerObjectDiagnostic(stderr: string): boolean {
  return /(?:no such object|no such container):/i.test(stderr);
}

export class DockerGitHubWorkspaceImporter {
  readonly #image: string;
  readonly #network: string;
  readonly #dockerCommand: string;
  readonly #timeoutMs: number;
  readonly #idGenerator: () => string;

  constructor(options: DockerGitHubWorkspaceImporterOptions) {
    this.#image = bounded(options.image, "Repository importer image", 1_024);
    this.#network = dockerNetwork(options.network);
    this.#dockerCommand = bounded(options.dockerCommand ?? "docker", "Docker command", 1_024);
    this.#timeoutMs = positiveTimeout(options.timeoutMs ?? 180_000);
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async import(source: GitHubRepositorySource, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) {
      throw new GitHubWorkspaceImporterError(
        "repository_import_cancelled",
        "Repository import was cancelled",
        true,
      );
    }
    const importId = this.#idGenerator();
    const name = `agent-dock-import-${importId}`.slice(0, 63);
    const child = spawn(
      this.#dockerCommand,
      buildDockerGitHubWorkspaceImportArguments(this.#image, this.#network, name, importId),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_STDOUT_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, rejectPromise) => {
        child.once("error", () => {
          rejectPromise(
            new GitHubWorkspaceImporterError(
              "repository_import_start_failed",
              "Repository importer could not start",
              true,
            ),
          );
        });
        child.once("close", (code, closeSignal) => resolvePromise({ code, signal: closeSignal }));
      },
    );
    // A synchronous stdin failure can otherwise leave the child error promise
    // rejected after this method has already entered cleanup.
    void exit.catch(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    let rejectCancellation!: (error: GitHubWorkspaceImporterError) => void;
    const cancellation = new Promise<never>((_resolve, rejectPromise) => {
      rejectCancellation = rejectPromise;
    });
    const abort = (): void => {
      child.kill("SIGTERM");
      rejectCancellation(
        new GitHubWorkspaceImporterError(
          "repository_import_cancelled",
          "Repository import was cancelled",
          true,
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    const timedExit = Promise.race([
      exit,
      cancellation,
      new Promise<never>((_resolve, rejectPromise) => {
        timeout = setTimeout(() => {
          child.kill("SIGTERM");
          rejectPromise(
            new GitHubWorkspaceImporterError(
              "repository_import_timeout",
              "Repository import timed out",
              true,
            ),
          );
        }, this.#timeoutMs);
        timeout.unref();
      }),
    ]);
    try {
      const request: GitHubWorkspaceImportRequest = {
        workspaceImportProtocolVersion: 1,
        type: "workspace.import",
        importId,
        source,
      };
      sendRequest(child, request);
      const result = await timedExit;
      if (overflow) {
        throw new GitHubWorkspaceImporterError(
          "repository_import_output_too_large",
          "Repository importer output exceeded its limit",
          false,
        );
      }
      const lines = stdout
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      if (lines.length !== 1) {
        throw new GitHubWorkspaceImporterError(
          "repository_import_protocol_error",
          "Repository importer returned invalid output",
          false,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[0]!) as unknown;
      } catch {
        throw new GitHubWorkspaceImporterError(
          "repository_import_protocol_error",
          "Repository importer returned invalid output",
          false,
        );
      }
      const output = parseGitHubWorkspaceImportOutput(parsed);
      if (output.importId !== importId) {
        throw new GitHubWorkspaceImporterError(
          "repository_import_identity_mismatch",
          "Repository importer identity did not match",
          false,
        );
      }
      if (output.type === "workspace.import.failed") {
        throw new GitHubWorkspaceImporterError(output.code, output.message, output.retryable);
      }
      if (result.code !== 0 || result.signal !== null) {
        throw new GitHubWorkspaceImporterError(
          "repository_import_process_failed",
          stderr.length > 0
            ? "Repository importer exited with diagnostic output"
            : "Repository importer exited unexpectedly",
          true,
        );
      }
      return decodeWorkspaceSnapshot(output.snapshot);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      child.stdin.destroy();
      await this.#removeIfPresent(name, importId);
    }
  }

  async #removeIfPresent(name: string, importId: string): Promise<void> {
    const inspected = await executeDocker(
      this.#dockerCommand,
      ["inspect", "--format", "{{json .Config.Labels}}", name],
      10_000,
    );
    if (inspected.error !== null) {
      if (isMissingDockerObjectDiagnostic(inspected.stderr)) return;
      throw new GitHubWorkspaceImporterError(
        "repository_import_cleanup_unverified",
        "Repository importer absence could not be verified",
        true,
      );
    }
    let labels: unknown;
    try {
      labels = JSON.parse(inspected.stdout.trim()) as unknown;
    } catch {
      throw new GitHubWorkspaceImporterError(
        "repository_import_cleanup_unverified",
        "Repository importer cleanup identity was invalid",
        false,
      );
    }
    if (
      typeof labels !== "object" ||
      labels === null ||
      (labels as Record<string, unknown>)["agent-dock.workspace-import"] !== "true" ||
      (labels as Record<string, unknown>)["agent-dock.workspace-import-id"] !== importId
    ) {
      throw new GitHubWorkspaceImporterError(
        "repository_import_cleanup_unverified",
        "Repository importer cleanup identity did not match",
        false,
      );
    }
    const removed = await executeDocker(this.#dockerCommand, ["rm", "--force", name], 10_000);
    if (removed.error !== null) {
      if (isMissingDockerObjectDiagnostic(removed.stderr)) return;
      throw new GitHubWorkspaceImporterError(
        "repository_import_cleanup_unverified",
        "Repository importer could not be removed",
        true,
      );
    }
    const remaining = await executeDocker(
      this.#dockerCommand,
      ["inspect", "--format", "{{.Id}}", name],
      10_000,
    );
    if (remaining.error !== null && isMissingDockerObjectDiagnostic(remaining.stderr)) return;
    throw new GitHubWorkspaceImporterError(
      "repository_import_cleanup_unverified",
      remaining.error === null
        ? "Repository importer removal could not be confirmed"
        : "Repository importer absence could not be verified",
      true,
    );
  }
}
