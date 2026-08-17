import {
  modelSamplingHeaders,
  parseInternalServiceError,
  parseToolSandboxOperationResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashOperations,
  type EditOperations,
  type ReadToolInput,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import type { FrozenCloudStep } from "./cloud-context.ts";
import type { PiWorldStateModelMessage } from "./pi-sandbox-continuity.ts";

const WORKSPACE_ROOT = "/workspace";
const MAX_RESPONSE_BYTES = 5 * 1_024 * 1_024;
const MAX_PROJECT_INSTRUCTIONS_BYTES = 16 * 1_024;

/**
 * The Cube guest admits one cancellable Tool operation per activation. Pi must
 * therefore preserve model order before requests cross Tool RPC. Changing this
 * requires a coordinated guest-protocol and Workspace-consistency redesign;
 * marking only read as parallel is not safe because one sequential Tool makes
 * Pi serialize the complete sibling batch anyway.
 */
export const CLOUD_TOOL_EXECUTION_MODE = "sequential" as const;

type RemoteOperationInput<T = ToolSandboxOperationRequest> = T extends unknown
  ? Omit<
      T,
      | "toolBrokerProtocolVersion"
      | "type"
      | "activationId"
      | "operationId"
      | "turnContextSha256"
      | "attemptContextSha256"
      | "stepContextSequence"
      | "stepContextSha256"
    >
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
  turnContextSha256: string;
  attemptContextSha256: string;
  captureStepContext: (
    activeTools: readonly string[],
    purpose?: "agent" | "context_maintenance",
  ) =>
    | Readonly<{
        step: FrozenCloudStep;
        modelMessages: readonly PiWorldStateModelMessage[];
        samplingAttempt: number;
      }>
    | Promise<
        Readonly<{
          step: FrozenCloudStep;
          modelMessages: readonly PiWorldStateModelMessage[];
          samplingAttempt: number;
        }>
      >;
  onToolOperationStarted?: () => void | Promise<void>;
  onToolOperationUnavailable?: () => void | Promise<void>;
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
  const turnContextSha256 = candidate.turnContextSha256;
  const attemptContextSha256 = candidate.attemptContextSha256;
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
    !/^pcts_[A-Za-z0-9_-]{43}$/.test(capability) ||
    !/^[0-9a-f]{64}$/.test(turnContextSha256) ||
    !/^[0-9a-f]{64}$/.test(attemptContextSha256) ||
    typeof candidate.captureStepContext !== "function" ||
    (candidate.onToolOperationStarted !== undefined &&
      typeof candidate.onToolOperationStarted !== "function") ||
    (candidate.onToolOperationUnavailable !== undefined &&
      typeof candidate.onToolOperationUnavailable !== "function") ||
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
    turnContextSha256,
    attemptContextSha256,
    captureStepContext: candidate.captureStepContext,
    ...(candidate.onToolOperationStarted === undefined
      ? {}
      : { onToolOperationStarted: candidate.onToolOperationStarted }),
    ...(candidate.onToolOperationUnavailable === undefined
      ? {}
      : { onToolOperationUnavailable: candidate.onToolOperationUnavailable }),
    remainingToolCalls,
    maximumToolOutputBytes,
    toolOutputDirectory,
    ...(projectInstructions === undefined ? {} : { projectInstructions }),
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

function utf8Head(value: Buffer, maximumBytes: number): Buffer {
  if (value.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (value[end]! & 0xc0) === 0x80) end -= 1;
  return value.subarray(0, end);
}

function utf8Tail(value: Buffer, maximumBytes: number): Buffer {
  if (value.byteLength <= maximumBytes) return value;
  let start = value.byteLength - maximumBytes;
  while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

function modelOutputPreview(value: Buffer, maximumBytes: number, toolCallId: string): Buffer {
  if (value.byteLength <= maximumBytes) return value;
  const marker = Buffer.from(
    `\n\n[PiCloud omitted the middle of this output from model context. The complete output is preserved as the tool-output artifact for tool call ${toolCallId}. Rerun a focused command with tail, grep, or sed to inspect omitted sections.]\n\n`,
    "utf8",
  );
  const bodyBytes = Math.max(0, maximumBytes - marker.byteLength);
  const headBytes = Math.min(8 * 1_024, Math.floor(bodyBytes / 5));
  const tailBytes = Math.max(0, bodyBytes - headBytes);
  return Buffer.concat([utf8Head(value, headBytes), marker, utf8Tail(value, tailBytes)]);
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

function orderedBashOutput(
  response: Extract<
    ToolSandboxOperationResponse,
    { type: "tool_sandbox.operation_result"; operation: "bash.exec" }
  >,
): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const [index, chunk] of response.outputChunks.entries()) {
    if (chunk.seq !== index + 1) {
      throw new RemoteToolError(
        "tool_output_sequence_invalid",
        "Tool Sandbox returned non-contiguous command output",
        false,
      );
    }
    const bytes = canonicalBase64(chunk.data);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      throw new RemoteToolError(
        "tool_protocol_error",
        "Tool Sandbox command output exceeded its trusted byte limit",
        false,
      );
    }
    chunks.push(bytes);
  }
  const output = Buffer.concat(chunks);
  if (createHash("sha256").update(output).digest("hex") !== response.outputSha256) {
    throw new RemoteToolError(
      "tool_output_digest_mismatch",
      "Tool Sandbox returned corrupt command output",
      false,
    );
  }
  return output;
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

type TrustedRemoteToolBindings = Readonly<{
  transformContext(
    messages: readonly AgentMessage[],
    purpose: "agent" | "context_maintenance",
  ): Promise<AgentMessage[]>;
}>;

function registerTrustedRemoteTools(
  pi: ExtensionAPI,
  runtime: TrustedRemoteToolsRuntimeConfiguration,
): TrustedRemoteToolBindings {
  let remainingToolCalls = runtime.remainingToolCalls;
  let currentStep: FrozenCloudStep | undefined;
  let currentSamplingAttempt: number | undefined;
  let currentSamplingHeadersIssued = false;

  const captureStep = async (purpose: "agent" | "context_maintenance") => {
    const captured = await runtime.captureStepContext(pi.getActiveTools(), purpose);
    if (
      captured.step.context.turnContextSha256 !== runtime.turnContextSha256 ||
      captured.step.context.attemptContextSha256 !== runtime.attemptContextSha256 ||
      !/^[0-9a-f]{64}$/.test(captured.step.sha256)
    ) {
      throw new Error("Captured Cloud Step did not match the accepted Turn and Attempt contexts");
    }
    currentStep = captured.step;
    currentSamplingAttempt = captured.samplingAttempt;
    currentSamplingHeadersIssued = false;
    return captured;
  };

  const transformContext = async (
    event: { messages: readonly AgentMessage[] },
    purpose: "agent" | "context_maintenance",
  ): Promise<AgentMessage[]> => {
    currentStep = undefined;
    currentSamplingAttempt = undefined;
    const captured = await captureStep(purpose);
    const messages = [...event.messages];
    for (const message of captured.modelMessages) {
      const alreadyPresent = messages.some(
        (candidate) =>
          candidate.role === "custom" &&
          candidate.customType === message.customType &&
          typeof candidate.details === "object" &&
          candidate.details !== null &&
          (candidate.details as { changeSha256?: unknown }).changeSha256 ===
            message.details.changeSha256,
      );
      if (!alreadyPresent) {
        messages.push({
          role: "custom",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
          timestamp: Date.now(),
        });
      }
    }
    return messages;
  };
  pi.on("context", async (event) => ({ messages: await transformContext(event, "agent") }));

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
    if (currentStep === undefined) {
      throw new RemoteToolError(
        "step_context_unavailable",
        "Tool call preceded its Pi context boundary",
        false,
      );
    }
    await runtime.onToolOperationStarted?.();
    const candidate = {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: runtime.activationId,
      operationId: randomUUID(),
      turnContextSha256: runtime.turnContextSha256,
      attemptContextSha256: runtime.attemptContextSha256,
      stepContextSequence: currentStep.context.sequence,
      stepContextSha256: currentStep.sha256,
      ...request,
    } as ToolSandboxOperationRequest;
    const requestOnce = async (): Promise<{ response: Response; value: unknown }> => {
      const response = await fetch(runtime.operationUrl, {
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
      return { response, value: await responseJson(response) };
    };
    let received: { response: Response; value: unknown } | undefined;
    let transportFailure: unknown;
    for (let attempt = 0; attempt < 2 && received === undefined; attempt += 1) {
      try {
        received = await requestOnce();
      } catch (error: unknown) {
        if (signal?.aborted) throw new Error("aborted");
        if (error instanceof RemoteToolError) throw errorForPi(error);
        transportFailure = error;
      }
    }
    if (received === undefined) throw errorForPi(transportFailure);
    const { response, value } = received;
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(value).error;
        if (failure.code === "cubesandbox_tool_result_unknown") {
          await runtime.onToolOperationUnavailable?.();
        }
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
    if (parsed.type === "tool_sandbox.operation_failed") {
      if (parsed.code === "cubesandbox_tool_result_unknown") {
        await runtime.onToolOperationUnavailable?.();
      }
      throwFailure(parsed);
    }
    if (parsed.operation !== candidate.operation) {
      throw new RemoteToolError(
        "tool_protocol_error",
        "Tool Sandbox response kind did not match",
        false,
      );
    }
    return parsed;
  };

  const preserveLargeOutput = async (
    toolCallId: string,
    value: Buffer,
    maximumInlineBytes = runtime.maximumToolOutputBytes,
  ): Promise<void> => {
    if (value.byteLength <= maximumInlineBytes) return;
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
        if (toolCallId !== undefined) {
          await preserveLargeOutput(
            toolCallId,
            content,
            Math.min(runtime.maximumToolOutputBytes, DEFAULT_MAX_BYTES),
          );
        }
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
        if (response.operation !== "file.write") throw new Error("Tool response kind changed");
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
  const editDigests = new Map<string, string>();
  const editOperations: EditOperations = {
    readFile: async (path) => {
      try {
        const response = await operation({ operation: "file.read", path });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "file.read") throw new Error("Tool response kind changed");
        const content = canonicalBase64(response.content);
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual !== response.sha256) {
          throw new RemoteToolError(
            "tool_protocol_error",
            "Tool Sandbox returned an invalid file digest",
            false,
          );
        }
        editDigests.set(path, response.sha256);
        return content;
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
    writeFile: async (path, content) => {
      const expectedSha256 = editDigests.get(path);
      editDigests.delete(path);
      if (expectedSha256 === undefined) {
        throw new Error("tool_edit_conflict: Edit did not read the current file revision");
      }
      try {
        const response = await operation({
          operation: "file.write",
          path,
          content,
          expectedSha256,
        });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "file.write") throw new Error("Tool response kind changed");
        const writtenSha256 = createHash("sha256").update(content, "utf8").digest("hex");
        if (writtenSha256 !== response.sha256) {
          throw new RemoteToolError(
            "tool_protocol_error",
            "Tool Sandbox returned an invalid written-file digest",
            false,
          );
        }
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
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
        const fullOutput = orderedBashOutput(response);
        const maximumModelBytes = Math.min(runtime.maximumToolOutputBytes, DEFAULT_MAX_BYTES);
        await preserveLargeOutput(toolCallId, fullOutput, maximumModelBytes);
        // Pi's Bash tool applies its own tail truncation at DEFAULT_MAX_BYTES.
        // Keeping this preview at or below that boundary ensures Pi receives
        // the head/tail preview selected from the original output instead of
        // truncating an already-truncated prefix a second time.
        const output = modelOutputPreview(fullOutput, maximumModelBytes, toolCallId);
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
      "## PiCloud execution context",
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
    // Pi compaction and branch-summary requests use ModelRuntime directly and
    // therefore do not pass through the Agent `context` hook. Give each such
    // maintenance request a fresh governed sampling identity instead of
    // reusing the preceding Agent Step and colliding in the request ledger.
    if (currentSamplingHeadersIssued) await captureStep("context_maintenance");
    if (currentStep === undefined || currentSamplingAttempt === undefined) {
      throw new Error("Model request preceded its Cloud Step capture");
    }
    Object.assign(
      event.headers,
      modelSamplingHeaders({
        stepSequence: currentStep.context.sequence,
        stepSha256: currentStep.sha256,
        samplingAttempt: currentSamplingAttempt,
      }),
    );
    currentSamplingHeadersIssued = true;
  });

  const readTool = createReadTool(WORKSPACE_ROOT);
  const writeTool = createWriteTool(WORKSPACE_ROOT);
  const editTool = createEditTool(WORKSPACE_ROOT);
  const bashTool = createBashTool(WORKSPACE_ROOT);

  pi.registerTool({
    ...readTool,
    executionMode: CLOUD_TOOL_EXECUTION_MODE,
    async execute(id, params, signal, onUpdate) {
      consumeToolCall();
      const input = params as ReadToolInput;
      if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(input.path)) {
        return createReadTool(WORKSPACE_ROOT, { operations: readOperations(id) }).execute(
          id,
          params,
          signal,
          onUpdate,
        );
      }
      const offsetLine = input.offset ?? 1;
      const requestedLimit = input.limit ?? DEFAULT_MAX_LINES;
      if (
        !Number.isSafeInteger(offsetLine) ||
        offsetLine < 1 ||
        !Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 1
      ) {
        throw new Error("tool_read_range_invalid: offset and limit must be positive integers");
      }
      try {
        const response = await operation(
          {
            operation: "file.read_range",
            path: input.path,
            offsetLine,
            limitLines: Math.min(DEFAULT_MAX_LINES, requestedLimit),
          },
          signal,
        );
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "file.read_range") {
          throw new Error("Tool response kind changed");
        }
        if (response.firstLineBytes !== undefined) {
          return {
            content: [
              {
                type: "text",
                text: `[Line ${response.startLine} is ${response.firstLineBytes} bytes, exceeds ${DEFAULT_MAX_BYTES} byte limit. Use bash with sed/head to inspect a bounded slice.]`,
              },
            ],
            details: undefined,
          };
        }
        const range = canonicalBase64(response.content);
        const maximumInlineBytes = Math.min(runtime.maximumToolOutputBytes, DEFAULT_MAX_BYTES);
        await preserveLargeOutput(id, range, maximumInlineBytes);
        let output = modelOutputPreview(range, maximumInlineBytes, id).toString("utf8");
        if (response.nextOffsetLine !== undefined) {
          output += `\n\n[Showing lines ${response.startLine}-${response.endLine}. Use offset=${response.nextOffsetLine} to continue.]`;
        }
        return { content: [{ type: "text", text: output }], details: undefined };
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
  });
  pi.registerTool({
    ...writeTool,
    executionMode: CLOUD_TOOL_EXECUTION_MODE,
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
    executionMode: CLOUD_TOOL_EXECUTION_MODE,
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
    executionMode: CLOUD_TOOL_EXECUTION_MODE,
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
  return {
    transformContext: (messages, purpose) => transformContext({ messages }, purpose),
  };
}

export function createTrustedRemoteToolsExtension(
  configuration: TrustedRemoteToolsRuntimeConfiguration,
): InlineExtension {
  const runtime = validateRuntimeConfiguration(configuration);
  return (pi) => {
    registerTrustedRemoteTools(pi, runtime);
  };
}

export type TrustedRemoteAgentTools = Readonly<{
  tools: readonly AgentTool[];
  systemPrompt(base: string): Promise<string>;
  transformContext(
    messages: AgentMessage[],
    purpose?: "agent" | "context_maintenance",
  ): Promise<AgentMessage[]>;
  transformHeaders(headers?: ProviderHeaders): Promise<ProviderHeaders>;
}>;

/**
 * Exposes the reviewed remote Tool implementation to Pi's lower-level native
 * Agent runtime without duplicating the security-sensitive RPC code.
 */
export function createTrustedRemoteAgentTools(
  configuration: TrustedRemoteToolsRuntimeConfiguration,
): TrustedRemoteAgentTools {
  const runtime = validateRuntimeConfiguration(configuration);
  const handlers = new Map<string, (event: any) => unknown | Promise<unknown>>();
  const tools: AgentTool[] = [];
  const extensionApi = {
    on(type: string, handler: (event: any) => unknown | Promise<unknown>) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    getActiveTools() {
      return tools.map((tool) => tool.name);
    },
    registerTool(tool: AgentTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  const bindings = registerTrustedRemoteTools(extensionApi, runtime);

  const requireHandler = (type: string): ((event: any) => unknown | Promise<unknown>) => {
    const handler = handlers.get(type);
    if (handler === undefined) throw new Error(`Trusted remote Tool hook is missing: ${type}`);
    return handler;
  };

  return {
    tools,
    async systemPrompt(base) {
      const result = await requireHandler("before_agent_start")({ systemPrompt: base });
      if (
        typeof result !== "object" ||
        result === null ||
        !("systemPrompt" in result) ||
        typeof result.systemPrompt !== "string"
      ) {
        throw new Error("Trusted remote Tool system-prompt hook returned an invalid result");
      }
      return result.systemPrompt;
    },
    async transformContext(messages, purpose = "agent") {
      return bindings.transformContext(messages, purpose);
    },
    async transformHeaders(headers = {}) {
      const mutable = { ...headers };
      await requireHandler("before_provider_headers")({ headers: mutable });
      return mutable;
    },
  };
}
