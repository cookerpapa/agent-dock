import {
  parseInternalServiceError,
  parseToolSandboxOperationResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
} from "@agent-dock/protocol";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";

const WORKSPACE_ROOT = "/workspace";
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_PROJECT_INSTRUCTIONS_BYTES = 16 * 1_024;

type RemoteOperationInput<T = ToolSandboxOperationRequest> = T extends unknown
  ? Omit<T, "managerProtocolVersion" | "type" | "activationId" | "operationId">
  : never;

class RemoteToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "RemoteToolError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type TrustedRemoteToolsRuntimeConfiguration = {
  operationUrl: string;
  activationId: string;
  capability: string;
  remainingToolCalls: number;
  maximumToolOutputBytes: number;
  toolOutputDirectory: string;
  projectInstructions?: string;
  traceparent?: string;
  tracestate?: string;
};

function validateRuntimeConfiguration(
  candidate: TrustedRemoteToolsRuntimeConfiguration,
): TrustedRemoteToolsRuntimeConfiguration {
  const operationUrl = candidate.operationUrl;
  const parsed = new URL(operationUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Trusted Tool Sandbox operation URL is invalid");
  }
  const activationId = candidate.activationId;
  const capability = candidate.capability;
  const remainingToolCalls = candidate.remainingToolCalls;
  const maximumToolOutputBytes = candidate.maximumToolOutputBytes;
  const configuredToolOutputDirectory = candidate.toolOutputDirectory;
  const projectInstructions = candidate.projectInstructions;
  const traceparent = candidate.traceparent;
  const tracestate = candidate.tracestate;
  const toolOutputDirectory = resolve(configuredToolOutputDirectory);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      activationId,
    ) ||
    !/^adts_[A-Za-z0-9_-]{43}$/.test(capability) ||
    !Number.isSafeInteger(remainingToolCalls) ||
    remainingToolCalls < 0 ||
    remainingToolCalls > 10_000 ||
    !Number.isSafeInteger(maximumToolOutputBytes) ||
    maximumToolOutputBytes < 1_024 ||
    maximumToolOutputBytes > 1_048_576 ||
    !isAbsolute(configuredToolOutputDirectory) ||
    toolOutputDirectory !== configuredToolOutputDirectory ||
    toolOutputDirectory === "/"
  ) {
    throw new Error("Trusted Tool Sandbox identity is invalid");
  }
  if (
    projectInstructions !== undefined &&
    (Buffer.byteLength(projectInstructions, "utf8") > MAX_PROJECT_INSTRUCTIONS_BYTES ||
      projectInstructions.includes("\0") ||
      projectInstructions.trim().length === 0)
  ) {
    throw new Error("Trusted project instructions are invalid");
  }
  if (
    traceparent !== undefined &&
    !/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/.test(traceparent)
  ) {
    throw new Error("Trusted trace context is invalid");
  }
  if (
    tracestate !== undefined &&
    (traceparent === undefined || tracestate.length < 1 || tracestate.length > 512)
  ) {
    throw new Error("Trusted trace state is invalid");
  }
  return {
    operationUrl: parsed.toString(),
    activationId,
    capability,
    remainingToolCalls,
    maximumToolOutputBytes,
    toolOutputDirectory,
    ...(projectInstructions === undefined ? {} : { projectInstructions }),
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

function boundedOutput(value: Buffer, maximumBytes: number): Buffer {
  if (value.byteLength <= maximumBytes) return value;
  const marker = Buffer.from("\n[AgentDock truncated command output]\n", "utf8");
  const bodyBytes = Math.max(0, maximumBytes - marker.byteLength);
  return Buffer.concat([value.subarray(0, bodyBytes), marker]);
}

function canonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength > MAX_RESPONSE_BYTES) {
    throw new RemoteToolError(
      "tool_protocol_error",
      "Tool Sandbox returned invalid binary output",
      false,
    );
  }
  return decoded;
}

async function responseJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new RemoteToolError(
      "tool_protocol_error",
      "Tool Sandbox response was outside its byte limit",
      false,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new RemoteToolError("tool_protocol_error", "Tool Sandbox returned malformed JSON", false);
  }
}

function throwFailure(
  response: Extract<ToolSandboxOperationResponse, { type: "tool_sandbox.operation_failed" }>,
): never {
  throw new RemoteToolError(response.code, response.message, response.retryable);
}

function errorForPi(error: unknown, timeoutSeconds?: number): Error {
  if (error instanceof RemoteToolError) {
    if (error.code === "tool_timeout") return new Error(`timeout:${String(timeoutSeconds ?? 0)}`);
    if (error.code === "tool_cancelled") return new Error("aborted");
    return new Error(`${error.code}: ${error.message}`);
  }
  return new Error("Tool Sandbox request failed");
}

function registerTrustedRemoteTools(
  pi: ExtensionAPI,
  runtime: TrustedRemoteToolsRuntimeConfiguration,
): void {
  let remainingToolCalls = runtime.remainingToolCalls;

  const consumeToolCall = (): void => {
    if (remainingToolCalls < 1) {
      throw new Error("tool_budget_exhausted: Run tool-call budget is exhausted");
    }
    remainingToolCalls -= 1;
  };

  const operation = async (
    request: RemoteOperationInput,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> => {
    const candidate = {
      managerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: runtime.activationId,
      operationId: randomUUID(),
      ...request,
    } as ToolSandboxOperationRequest;
    let response: Response;
    try {
      response = await fetch(runtime.operationUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.capability}`,
          "content-type": "application/json",
          ...(runtime.traceparent === undefined ? {} : { traceparent: runtime.traceparent }),
          ...(runtime.tracestate === undefined ? {} : { tracestate: runtime.tracestate }),
        },
        body: JSON.stringify(candidate),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (signal?.aborted) throw new Error("aborted");
      throw errorForPi(error);
    }
    const value = await responseJson(response);
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(value).error;
        throw new RemoteToolError(failure.code, failure.message, failure.retryable);
      } catch (error: unknown) {
        if (error instanceof RemoteToolError) throw error;
        throw new RemoteToolError(
          "tool_protocol_error",
          "Tool Sandbox returned an invalid failure",
          false,
        );
      }
    }
    const parsed = parseToolSandboxOperationResponse(value);
    if (
      parsed.activationId !== runtime.activationId ||
      parsed.operationId !== candidate.operationId
    ) {
      throw new RemoteToolError(
        "tool_protocol_error",
        "Tool Sandbox response identity did not match",
        false,
      );
    }
    if (parsed.type === "tool_sandbox.operation_failed") throwFailure(parsed);
    if (parsed.operation !== candidate.operation) {
      throw new RemoteToolError(
        "tool_protocol_error",
        "Tool Sandbox response kind did not match",
        false,
      );
    }
    return parsed;
  };

  const preserveLargeOutput = async (toolCallId: string, value: Buffer): Promise<void> => {
    if (value.byteLength <= runtime.maximumToolOutputBytes) return;
    const fileName = `${createHash("sha256").update(toolCallId, "utf8").digest("hex")}.output`;
    const target = resolve(runtime.toolOutputDirectory, fileName);
    if (!target.startsWith(`${runtime.toolOutputDirectory}${sep}`)) {
      throw new Error("tool_artifact_path_invalid: Tool output artifact path escaped");
    }
    await writeFile(target, value, { flag: "wx", mode: 0o600 });
  };

  const readOperations = (toolCallId?: string): ReadOperations => ({
    readFile: async (path) => {
      try {
        const response = await operation({ operation: "file.read", path });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "file.read") throw new Error("Tool response kind changed");
        const content = canonicalBase64(response.content);
        if (toolCallId !== undefined) await preserveLargeOutput(toolCallId, content);
        return content;
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
    access: async (path) => {
      try {
        const response = await operation({ operation: "file.access", path });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
    detectImageMimeType: async (path) => {
      switch (extname(path).toLowerCase()) {
        case ".png":
          return "image/png";
        case ".jpg":
        case ".jpeg":
          return "image/jpeg";
        case ".gif":
          return "image/gif";
        case ".webp":
          return "image/webp";
        default:
          return null;
      }
    },
  });
  const writeOperations: WriteOperations = {
    writeFile: async (path, content) => {
      try {
        const response = await operation({ operation: "file.write", path, content });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
    mkdir: async (path) => {
      try {
        const response = await operation({ operation: "file.mkdir", path });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
  };
  const editOperations: EditOperations = {
    readFile: readOperations().readFile,
    writeFile: writeOperations.writeFile,
    access: readOperations().access,
  };
  const bashOperations = (toolCallId: string): BashOperations => ({
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const timeoutSeconds = timeout && timeout > 0 ? timeout : 10;
      try {
        // Deliberately do not forward the `env` argument. It contains the
        // trusted Pi/model environment and must never cross into Tool Sandbox.
        const response = await operation(
          {
            operation: "bash.exec",
            command,
            cwd,
            timeoutMs: Math.min(300_000, Math.max(100, Math.ceil(timeoutSeconds * 1_000))),
          },
          signal,
        );
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "bash.exec") throw new Error("Tool response kind changed");
        const fullOutput = canonicalBase64(response.output);
        await preserveLargeOutput(toolCallId, fullOutput);
        const output = boundedOutput(fullOutput, runtime.maximumToolOutputBytes);
        if (output.byteLength > 0) onData(output);
        return { exitCode: response.exitCode };
      } catch (error: unknown) {
        throw errorForPi(error, timeoutSeconds);
      }
    },
  });

  pi.on("before_agent_start", async (event) => {
    const cwdLine = /^Current working directory:.*$/m;
    const sandboxLine = "Current working directory: /workspace (isolated Tool Sandbox)";
    const basePrompt = cwdLine.test(event.systemPrompt)
      ? event.systemPrompt.replace(cwdLine, sandboxLine)
      : `${event.systemPrompt}\n\n${sandboxLine}`;
    const platformContext = [
      "## AgentDock execution context",
      "All file and command tools operate in the isolated /workspace Tool Sandbox.",
      "Large tool results are bounded in model context and preserved as tenant-scoped artifacts.",
    ].join("\n");
    if (runtime.projectInstructions === undefined) {
      return { systemPrompt: `${basePrompt}\n\n${platformContext}` };
    }
    return {
      systemPrompt: `${basePrompt}\n\n${platformContext}\n\n## Project instructions (repository-controlled)\n${runtime.projectInstructions}`,
    };
  });

  pi.on("before_provider_headers", async (event) => {
    if (runtime.traceparent !== undefined) event.headers.traceparent = runtime.traceparent;
    if (runtime.tracestate !== undefined) event.headers.tracestate = runtime.tracestate;
  });

  const readTool = createReadTool(WORKSPACE_ROOT);
  const writeTool = createWriteTool(WORKSPACE_ROOT);
  const editTool = createEditTool(WORKSPACE_ROOT);
  const bashTool = createBashTool(WORKSPACE_ROOT);

  pi.registerTool({
    ...readTool,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate) {
      consumeToolCall();
      return createReadTool(WORKSPACE_ROOT, { operations: readOperations(id) }).execute(
        id,
        params,
        signal,
        onUpdate,
      );
    },
  });
  pi.registerTool({
    ...writeTool,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate) {
      consumeToolCall();
      return createWriteTool(WORKSPACE_ROOT, { operations: writeOperations }).execute(
        id,
        params,
        signal,
        onUpdate,
      );
    },
  });
  pi.registerTool({
    ...editTool,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate) {
      consumeToolCall();
      return createEditTool(WORKSPACE_ROOT, { operations: editOperations }).execute(
        id,
        params,
        signal,
        onUpdate,
      );
    },
  });
  pi.registerTool({
    ...bashTool,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate) {
      consumeToolCall();
      return createBashTool(WORKSPACE_ROOT, { operations: bashOperations(id) }).execute(
        id,
        params,
        signal,
        onUpdate,
      );
    },
  });

  pi.on("user_bash", async () => {
    consumeToolCall();
    return { operations: bashOperations(randomUUID()) };
  });
}

export function createTrustedRemoteToolsExtension(
  configuration: TrustedRemoteToolsRuntimeConfiguration,
): InlineExtension {
  const runtime = validateRuntimeConfiguration(configuration);
  return (pi) => registerTrustedRemoteTools(pi, runtime);
}
