import {
  canonicalEnvironmentRecipeJson,
  isExpectedDefaultToolchain,
  MAX_TOOL_COMMAND_BYTES,
  MAX_TOOL_FILE_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  parseToolWorkerInput,
  type EnvironmentRuntimeSnapshot,
  type EnvironmentRecipeCommand,
  type EnvironmentRecipeCommandResult,
  type EnvironmentToolName,
  type EnvironmentToolchainReport,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolWorkerOutput,
} from "@agent-dock/protocol";
import {
  captureWorkspaceSnapshot,
  collectGitWorkspacePatch,
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  restoreWorkspaceSnapshot,
} from "@agent-dock/workspace-runtime";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

export const TOOL_WORKSPACE_DIRECTORY = "/workspace";
export const SAMPLE_JAVA_FIXTURE = "/opt/agent-dock/sample-java-repair";
const TOOL_IMAGE_REVISION_FILE = "/opt/agent-dock/image-revision";

export class ToolWorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = "ToolWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function execute(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 512 * 1_024,
        env: safeToolEnvironment(),
      },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
  });
}

function probeVersion(file: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      {
        cwd: TOOL_WORKSPACE_DIRECTORY,
        encoding: "utf8",
        maxBuffer: 8 * 1_024,
        timeout: 5_000,
        env: safeToolEnvironment(),
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new ToolWorkerError(
              "environment_preflight_failed",
              "Tool Sandbox environment preflight failed",
              false,
            ),
          );
          return;
        }
        const output = `${stdout}${stderr}`.trim().split("\n", 1)[0]?.trim() ?? "";
        if (output.length < 1 || output.length > 256 || /[\u0000-\u001f\u007f]/.test(output)) {
          rejectPromise(
            new ToolWorkerError(
              "environment_preflight_failed",
              "Tool Sandbox environment preflight failed",
              false,
            ),
          );
          return;
        }
        resolvePromise(output);
      },
    );
  });
}

async function readBakedImageRevision(): Promise<string> {
  let handle;
  try {
    handle = await open(TOOL_IMAGE_REVISION_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(130);
    const result = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (result.bytesRead === bytes.byteLength) {
      throw new ToolWorkerError(
        "environment_image_evidence_invalid",
        "Tool Sandbox image revision evidence was invalid",
        false,
      );
    }
    return bytes.subarray(0, result.bytesRead).toString("utf8").trim();
  } catch (error) {
    if (error instanceof ToolWorkerError) throw error;
    throw new ToolWorkerError(
      "environment_image_evidence_invalid",
      "Tool Sandbox image revision evidence was invalid",
      false,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validateToolEnvironment(
  environment: EnvironmentRuntimeSnapshot,
  physicalImageRevision?: string,
): Promise<EnvironmentToolchainReport> {
  const imageRevision = physicalImageRevision ?? (await readBakedImageRevision());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(imageRevision)) {
    throw new ToolWorkerError(
      "environment_image_evidence_invalid",
      "Tool Sandbox image revision evidence was invalid",
      false,
    );
  }
  if (imageRevision !== environment.imageRevision) {
    throw new ToolWorkerError(
      "environment_image_mismatch",
      "Tool Sandbox image revision did not match the accepted Run",
      false,
    );
  }
  const recipeSha256 = createHash("sha256")
    .update(canonicalEnvironmentRecipeJson(environment.recipe))
    .digest("hex");
  if (recipeSha256 !== environment.recipeSha256) {
    throw new ToolWorkerError(
      "environment_recipe_mismatch",
      "Tool Sandbox environment recipe did not match the accepted Run",
      false,
    );
  }
  const probes: readonly [EnvironmentToolName, string, readonly string[]][] = [
    ["node", "/usr/local/bin/node", ["--version"]],
    ["java", "/usr/bin/java", ["-version"]],
    ["python", "/usr/bin/python3", ["--version"]],
    ["git", "/usr/bin/git", ["--version"]],
  ];
  const tools = await Promise.all(
    probes.map(async ([name, file, args]) => ({ name, version: await probeVersion(file, args) })),
  );
  const report: EnvironmentToolchainReport = {
    profileKey: environment.profileKey,
    profileVersion: environment.profileVersion,
    imageRevision: environment.imageRevision,
    specSha256: environment.specSha256,
    recipeSha256,
    tools,
    recipeCommands: [],
  };
  if (!isExpectedDefaultToolchain(report)) {
    throw new ToolWorkerError(
      "environment_toolchain_mismatch",
      "Tool Sandbox toolchain did not match its environment profile",
      false,
    );
  }
  return report;
}

type EnvironmentCommandExecution = {
  exitCode: number | null;
  output: Buffer;
  timedOut: boolean;
};

async function executeEnvironmentCommand(
  command: EnvironmentRecipeCommand,
  workspaceDirectory: string,
): Promise<EnvironmentCommandExecution> {
  if (command.network === "dependency") {
    throw new ToolWorkerError(
      "environment_dependency_network_unavailable",
      `Environment command ${command.id} requires an unavailable dependency network policy`,
      false,
    );
  }
  const workspaceRoot = await realpath(workspaceDirectory).catch(() => {
    throw new ToolWorkerError(
      "environment_workspace_unavailable",
      "Environment workspace was unavailable",
      false,
    );
  });
  const cwd = resolve(workspaceRoot, command.cwd);
  const fromRoot = relative(workspaceRoot, cwd);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ToolWorkerError(
      "environment_command_path_escape",
      `Environment command ${command.id} escaped the workspace`,
      false,
    );
  }
  const canonicalCwd = await realpath(cwd).catch(() => {
    throw new ToolWorkerError(
      "environment_command_working_directory_missing",
      `Environment command ${command.id} working directory was unavailable`,
      false,
    );
  });
  const canonicalFromRoot = relative(workspaceRoot, canonicalCwd);
  if (
    canonicalFromRoot === ".." ||
    canonicalFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(canonicalFromRoot)
  ) {
    throw new ToolWorkerError(
      "environment_command_path_escape",
      `Environment command ${command.id} escaped the workspace`,
      false,
    );
  }
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-lc", command.command], {
    cwd: canonicalCwd,
    detached: process.platform !== "win32",
    env: safeToolEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = Buffer.alloc(0);
  let overflow = false;
  let timedOut = false;
  const append = (chunk: Buffer): void => {
    if (overflow) return;
    output = Buffer.concat([output, chunk]);
    if (output.byteLength > MAX_TOOL_OUTPUT_BYTES) {
      overflow = true;
      terminateProcessGroup(child, "SIGKILL");
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, "SIGTERM");
    const force = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 250);
    force.unref();
  }, command.timeoutMs);
  timer.unref();
  try {
    const result = await new Promise<{ exitCode: number | null }>(
      (resolvePromise, rejectPromise) => {
        child.once("error", () =>
          rejectPromise(
            new ToolWorkerError(
              "environment_command_start_failed",
              `Environment command ${command.id} could not start`,
              false,
            ),
          ),
        );
        child.once("close", (exitCode) => resolvePromise({ exitCode }));
      },
    );
    if (overflow) {
      throw new ToolWorkerError(
        "environment_command_output_limit",
        `Environment command ${command.id} exceeded its output limit`,
        false,
      );
    }
    return { exitCode: result.exitCode, output, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export async function executeEnvironmentRecipe(
  environment: EnvironmentRuntimeSnapshot,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
): Promise<EnvironmentRecipeCommandResult[]> {
  const recipeSha256 = createHash("sha256")
    .update(canonicalEnvironmentRecipeJson(environment.recipe))
    .digest("hex");
  if (recipeSha256 !== environment.recipeSha256) {
    throw new ToolWorkerError(
      "environment_recipe_mismatch",
      "Tool Sandbox environment recipe did not match the accepted Run",
      false,
    );
  }
  const results: EnvironmentRecipeCommandResult[] = [];
  const phases = [
    ["setup", environment.recipe.setupCommands],
    ["verification", environment.recipe.verificationCommands],
  ] as const;
  for (const [phase, commands] of phases) {
    for (const command of commands) {
      const startedAt = Date.now();
      const result = await executeEnvironmentCommand(command, workspaceDirectory);
      if (result.timedOut) {
        throw new ToolWorkerError(
          "environment_command_timeout",
          `Environment command ${command.id} timed out`,
          false,
        );
      }
      if (result.exitCode !== 0) {
        throw new ToolWorkerError(
          phase === "setup"
            ? "environment_setup_command_failed"
            : "environment_verification_command_failed",
          `Environment command ${command.id} failed`,
          false,
        );
      }
      results.push({
        id: command.id,
        phase,
        exitCode: result.exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        outputSha256: createHash("sha256").update(result.output).digest("hex"),
      });
    }
  }
  return results;
}

export function safeToolEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp/agent-dock-tool-home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    // Kubernetes emptyDir volumes are mounted with root ownership and the
    // Pod's fsGroup, even though every process and repository entry is owned
    // by uid 1000. Pin Git's trust exception to the one fixed workspace root;
    // never accept a user-controlled path here.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: TOOL_WORKSPACE_DIRECTORY,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

function byteLengthWithin(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
}

function isInsideWorkspace(path: string): boolean {
  const fromRoot = relative(TOOL_WORKSPACE_DIRECTORY, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

export function resolveToolWorkspacePath(input: string): string {
  if (
    input.length < 1 ||
    input.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(input) ||
    input.includes("\\")
  ) {
    throw new ToolWorkerError("invalid_tool_path", "Tool path is invalid");
  }
  const resolved = resolve(TOOL_WORKSPACE_DIRECTORY, input);
  if (!isInsideWorkspace(resolved)) {
    throw new ToolWorkerError("tool_path_escape", "Tool path escaped the workspace");
  }
  return resolved;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function assertRealPathInsideWorkspace(path: string): Promise<void> {
  const canonical = await realpath(path).catch((error: unknown) => {
    throw isMissing(error)
      ? new ToolWorkerError("tool_path_missing", "Tool path does not exist")
      : error;
  });
  if (!isInsideWorkspace(canonical)) {
    throw new ToolWorkerError("tool_path_escape", "Tool path escaped the workspace");
  }
}

async function assertNoFinalSymlink(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata?.isSymbolicLink()) {
    throw new ToolWorkerError("tool_symlink_rejected", "Tool path was a symbolic link");
  }
}

async function ensureWorkspaceDirectory(path: string): Promise<void> {
  const relativePath = relative(TOOL_WORKSPACE_DIRECTORY, path);
  if (relativePath === "") return;
  let current = TOOL_WORKSPACE_DIRECTORY;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const metadata = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (metadata === undefined) {
      await mkdir(current, { mode: 0o755 });
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ToolWorkerError(
        "tool_directory_rejected",
        "Tool directory path contains a link or non-directory",
      );
    }
  }
}

async function readWorkspaceFile(path: string): Promise<Buffer> {
  const target = resolveToolWorkspacePath(path);
  await assertNoFinalSymlink(target);
  await assertRealPathInsideWorkspace(dirname(target));
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolWorkerError("tool_file_unavailable", "Tool file could not be read");
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_TOOL_FILE_BYTES) {
      throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
    }
    const content = await handle.readFile();
    if (content.byteLength > MAX_TOOL_FILE_BYTES) {
      throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  if (!byteLengthWithin(content, MAX_TOOL_FILE_BYTES)) {
    throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
  }
  const target = resolveToolWorkspacePath(path);
  await assertNoFinalSymlink(target);
  await assertRealPathInsideWorkspace(dirname(target));
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  ).catch(() => {
    throw new ToolWorkerError("tool_file_unavailable", "Tool file could not be written");
  });
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function accessWorkspaceFile(path: string): Promise<void> {
  const target = resolveToolWorkspacePath(path);
  await assertNoFinalSymlink(target);
  await assertRealPathInsideWorkspace(target);
  await access(target, constants.R_OK | constants.W_OK).catch(() => {
    throw new ToolWorkerError("tool_file_unavailable", "Tool file is not accessible");
  });
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
    }
  }
  child.kill(signal);
}

async function executeBash(
  request: Extract<ToolSandboxOperationRequest, { operation: "bash.exec" }>,
  signal: AbortSignal,
): Promise<Extract<ToolSandboxOperationResponse, { operation: "bash.exec" }>> {
  if (!byteLengthWithin(request.command, MAX_TOOL_COMMAND_BYTES)) {
    throw new ToolWorkerError("tool_command_limit", "Tool command is outside its byte limit");
  }
  const cwd = resolveToolWorkspacePath(request.cwd);
  await assertRealPathInsideWorkspace(cwd);
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-lc", request.command], {
    cwd,
    detached: process.platform !== "win32",
    env: safeToolEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = Buffer.alloc(0);
  let overflow = false;
  let timedOut = false;
  const append = (chunk: Buffer): void => {
    if (overflow) return;
    output = Buffer.concat([output, chunk]);
    if (output.byteLength > MAX_TOOL_OUTPUT_BYTES) {
      overflow = true;
      terminateProcessGroup(child, "SIGKILL");
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, "SIGTERM");
    const force = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 250);
    force.unref();
  }, request.timeoutMs);
  timer.unref();
  const abort = (): void => terminateProcessGroup(child, "SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await new Promise<{ code: number | null }>((resolvePromise, rejectPromise) => {
      child.once("error", () => {
        rejectPromise(
          new ToolWorkerError("tool_process_failed", "Tool process could not start", true),
        );
      });
      child.once("close", (code) => resolvePromise({ code }));
    });
    if (overflow) {
      throw new ToolWorkerError("tool_output_limit", "Tool output exceeded its byte limit");
    }
    if (timedOut) throw new ToolWorkerError("tool_timeout", "Tool command timed out", true);
    if (signal.aborted)
      throw new ToolWorkerError("tool_cancelled", "Tool command was cancelled", true);
    return {
      managerProtocolVersion: 1,
      type: "tool_sandbox.operation_result",
      activationId: request.activationId,
      operationId: request.operationId,
      operation: "bash.exec",
      exitCode: result.code,
      output: output.toString("base64"),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function executeOperation(
  request: ToolSandboxOperationRequest,
  signal: AbortSignal,
): Promise<ToolSandboxOperationResponse> {
  if (request.operation === "bash.exec") return executeBash(request, signal);
  if (request.operation === "file.read") {
    return {
      managerProtocolVersion: 1,
      type: "tool_sandbox.operation_result",
      activationId: request.activationId,
      operationId: request.operationId,
      operation: "file.read",
      content: (await readWorkspaceFile(request.path)).toString("base64"),
    };
  }
  if (request.operation === "file.write") await writeWorkspaceFile(request.path, request.content);
  if (request.operation === "file.mkdir") {
    await ensureWorkspaceDirectory(resolveToolWorkspacePath(request.path));
  }
  if (request.operation === "file.access") await accessWorkspaceFile(request.path);
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation_result",
    activationId: request.activationId,
    operationId: request.operationId,
    operation: request.operation,
  };
}

function failureResponse(
  request: ToolSandboxOperationRequest,
  error: unknown,
): ToolSandboxOperationResponse {
  const failure =
    error instanceof ToolWorkerError
      ? error
      : new ToolWorkerError("tool_operation_failed", "Tool operation failed", true);
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation_failed",
    activationId: request.activationId,
    operationId: request.operationId,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

function writeOutput(output: ToolWorkerOutput): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.write(`${JSON.stringify(output)}\n`, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

export async function prepareToolWorkspace(
  workspaceSeed: Parameters<typeof decodeWorkspaceSnapshotBlob>[0] | undefined,
  workspaceRestore: Parameters<typeof decodeWorkspaceSnapshotBlob>[0] | undefined,
): Promise<void> {
  const existing = await readdir(TOOL_WORKSPACE_DIRECTORY);
  if (existing.length !== 0) {
    throw new ToolWorkerError("workspace_not_empty", "Tool workspace was not empty");
  }
  if (workspaceSeed === undefined) {
    for (const entry of await readdir(SAMPLE_JAVA_FIXTURE)) {
      await cp(join(SAMPLE_JAVA_FIXTURE, entry), join(TOOL_WORKSPACE_DIRECTORY, entry), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  } else {
    await restoreWorkspaceSnapshot(
      TOOL_WORKSPACE_DIRECTORY,
      decodeWorkspaceSnapshotBlob(workspaceSeed),
    );
  }
  await execute("git", ["init", "--quiet"], TOOL_WORKSPACE_DIRECTORY);
  await execute("git", ["config", "user.name", "AgentDock Fixture"], TOOL_WORKSPACE_DIRECTORY);
  await execute(
    "git",
    ["config", "user.email", "fixture@agent-dock.invalid"],
    TOOL_WORKSPACE_DIRECTORY,
  );
  await execute("git", ["add", "--all"], TOOL_WORKSPACE_DIRECTORY);
  // An empty product Workspace is a valid starting point. Keep a real Git
  // baseline even when there are no files so later edits still produce a
  // deterministic diff against the accepted source snapshot.
  await execute(
    "git",
    ["commit", "--allow-empty", "--quiet", "-m", "fixture baseline"],
    TOOL_WORKSPACE_DIRECTORY,
  );
  if (workspaceRestore !== undefined) {
    await restoreWorkspaceSnapshot(
      TOOL_WORKSPACE_DIRECTORY,
      decodeWorkspaceSnapshotBlob(workspaceRestore),
    );
  }
}

export async function runToolWorker(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let activationId: string | undefined;
  let initialized = false;
  let shuttingDown = false;
  let active:
    { operationId: string; controller: AbortController; promise: Promise<void> } | undefined;
  const seenOperationIds = new Set<string>();

  const fail = async (
    error: unknown,
    identity?: { requestId?: string; operationId?: string },
  ): Promise<void> => {
    // This stream is collected only by the trusted Sandbox Manager. Keep the
    // protocol response deliberately generic, but retain an operator-facing
    // diagnostic so startup failures can be distinguished without weakening
    // the model-visible error boundary.
    const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[tool-worker] ${diagnostic}\n`);
    const failure =
      error instanceof ToolWorkerError
        ? error
        : new ToolWorkerError("tool_worker_failed", "Tool worker failed", true);
    await writeOutput({
      toolWorkerProtocolVersion: 1,
      type: "worker.failed",
      ...(activationId === undefined ? {} : { activationId }),
      ...(identity?.requestId === undefined ? {} : { requestId: identity.requestId }),
      ...(identity?.operationId === undefined ? {} : { operationId: identity.operationId }),
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    });
  };

  input.on("line", (line) => {
    void (async () => {
      if (shuttingDown || line.trim().length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new ToolWorkerError("tool_worker_protocol_error", "Tool worker input was invalid");
      }
      const message = parseToolWorkerInput(parsed);
      if (message.type === "worker.initialize") {
        if (initialized) {
          throw new ToolWorkerError(
            "tool_worker_protocol_error",
            "Tool worker was initialized twice",
          );
        }
        activationId = message.activationId;
        const environment = await validateToolEnvironment(message.environment);
        const seed =
          message.workspaceSeed.kind === "snapshot" ? message.workspaceSeed.snapshot : undefined;
        await prepareToolWorkspace(seed, message.workspaceRestore);
        environment.recipeCommands = await executeEnvironmentRecipe(message.environment);
        initialized = true;
        await writeOutput({
          toolWorkerProtocolVersion: 1,
          type: "worker.ready",
          activationId,
          environment,
        });
        return;
      }
      const messageActivationId =
        message.type === "worker.operation" ? message.request.activationId : message.activationId;
      if (!initialized || activationId === undefined || messageActivationId !== activationId) {
        throw new ToolWorkerError(
          "tool_worker_identity_mismatch",
          "Tool worker identity did not match",
        );
      }
      if (message.type === "worker.cancel") {
        if (active?.operationId === message.operationId) active.controller.abort();
        return;
      }
      if (message.type === "worker.shutdown") {
        shuttingDown = true;
        active?.controller.abort();
        await active?.promise.catch(() => undefined);
        input.close();
        process.stdin.pause();
        return;
      }
      if (message.type === "worker.capture") {
        if (active !== undefined) {
          throw new ToolWorkerError(
            "tool_operation_overlap",
            "Tool capture overlapped an operation",
          );
        }
        await writeOutput({
          toolWorkerProtocolVersion: 1,
          type: "worker.captured",
          activationId,
          requestId: message.requestId,
          workspace: encodeWorkspaceSnapshotBlob(
            await captureWorkspaceSnapshot(TOOL_WORKSPACE_DIRECTORY),
          ),
          workspacePatch: await collectGitWorkspacePatch(
            TOOL_WORKSPACE_DIRECTORY,
            safeToolEnvironment(),
          ),
        });
        return;
      }

      const request = message.request;
      if (request.activationId !== activationId) {
        throw new ToolWorkerError(
          "tool_worker_identity_mismatch",
          "Tool operation identity did not match",
        );
      }
      if (active !== undefined) {
        await writeOutput({
          toolWorkerProtocolVersion: 1,
          type: "worker.operation_result",
          response: failureResponse(
            request,
            new ToolWorkerError("tool_operation_overlap", "Another tool operation is active", true),
          ),
        });
        return;
      }
      if (seenOperationIds.has(request.operationId)) {
        await writeOutput({
          toolWorkerProtocolVersion: 1,
          type: "worker.operation_result",
          response: failureResponse(
            request,
            new ToolWorkerError("tool_operation_replay", "Tool operation ID was already used"),
          ),
        });
        return;
      }
      seenOperationIds.add(request.operationId);
      const controller = new AbortController();
      const promise = (async () => {
        const response = await executeOperation(request, controller.signal).catch(
          (error: unknown) => failureResponse(request, error),
        );
        await writeOutput({
          toolWorkerProtocolVersion: 1,
          type: "worker.operation_result",
          response,
        });
      })().finally(() => {
        if (active?.operationId === request.operationId) active = undefined;
      });
      active = { operationId: request.operationId, controller, promise };
    })().catch(async (error: unknown) => {
      await fail(error).catch(() => undefined);
    });
  });

  input.once("close", () => {
    shuttingDown = true;
    active?.controller.abort();
  });
}

if (process.argv[1] === import.meta.filename) await runToolWorker();
