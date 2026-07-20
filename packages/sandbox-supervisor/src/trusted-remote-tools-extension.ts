import {
  parseInternalServiceError,
  parseToolSandboxOperationResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
} from "@agent-dock/protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { randomUUID } from "node:crypto";
import { extname } from "node:path";

const WORKSPACE_ROOT = "/workspace";
const OPERATION_URL_ENV = "AGENT_DOCK_TRUSTED_TOOL_OPERATION_URL";
const ACTIVATION_ID_ENV = "AGENT_DOCK_TRUSTED_TOOL_ACTIVATION_ID";
const CAPABILITY_ENV = "AGENT_DOCK_TRUSTED_TOOL_CAPABILITY";
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length < 1 || value.length > 4_096 || /[\r\n\0]/.test(value)) {
    throw new Error(`Trusted remote tool configuration ${name} is invalid`);
  }
  return value;
}

function runtimeConfiguration(): {
  operationUrl: string;
  activationId: string;
  capability: string;
} {
  const operationUrl = requiredEnvironment(OPERATION_URL_ENV);
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
  const activationId = requiredEnvironment(ACTIVATION_ID_ENV);
  const capability = requiredEnvironment(CAPABILITY_ENV);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      activationId,
    ) ||
    !/^adts_[A-Za-z0-9_-]{43}$/.test(capability)
  ) {
    throw new Error("Trusted Tool Sandbox identity is invalid");
  }
  return { operationUrl: parsed.toString(), activationId, capability };
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

export default function trustedRemoteTools(pi: ExtensionAPI): void {
  const runtime = runtimeConfiguration();

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

  const readOperations: ReadOperations = {
    readFile: async (path) => {
      try {
        const response = await operation({ operation: "file.read", path });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "file.read") throw new Error("Tool response kind changed");
        return canonicalBase64(response.content);
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
  };
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
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
    access: readOperations.access,
  };
  const bashOperations: BashOperations = {
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
        const output = canonicalBase64(response.output);
        if (output.byteLength > 0) onData(output);
        return { exitCode: response.exitCode };
      } catch (error: unknown) {
        throw errorForPi(error, timeoutSeconds);
      }
    },
  };

  const readTool = createReadTool(WORKSPACE_ROOT);
  const writeTool = createWriteTool(WORKSPACE_ROOT);
  const editTool = createEditTool(WORKSPACE_ROOT);
  const bashTool = createBashTool(WORKSPACE_ROOT);

  pi.registerTool({
    ...readTool,
    async execute(id, params, signal, onUpdate) {
      return createReadTool(WORKSPACE_ROOT, { operations: readOperations }).execute(
        id,
        params,
        signal,
        onUpdate,
      );
    },
  });
  pi.registerTool({
    ...writeTool,
    async execute(id, params, signal, onUpdate) {
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
    async execute(id, params, signal, onUpdate) {
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
    async execute(id, params, signal, onUpdate) {
      return createBashTool(WORKSPACE_ROOT, { operations: bashOperations }).execute(
        id,
        params,
        signal,
        onUpdate,
      );
    },
  });

  pi.on("user_bash", async () => ({ operations: bashOperations }));
  pi.on("before_agent_start", async (event) => {
    const currentDirectoryLine = /^Current working directory:.*$/m;
    const replacement = "Current working directory: /workspace (isolated Tool Sandbox)";
    return {
      systemPrompt: currentDirectoryLine.test(event.systemPrompt)
        ? event.systemPrompt.replace(currentDirectoryLine, replacement)
        : `${event.systemPrompt}\n\n${replacement}`,
    };
  });
}
