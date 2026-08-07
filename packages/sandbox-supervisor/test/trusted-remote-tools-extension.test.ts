import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedRemoteToolsExtension } from "../src/trusted-remote-tools-extension.ts";

const ACTIVE_TOOLS = ["read", "write", "edit", "bash"] as const;
const EXECUTION_CONTEXT_SHA256 = "b".repeat(64);

function createStepCapture() {
  let sequence = 0;
  return (activeTools: readonly string[]) => {
    sequence += 1;
    const context = {
      schemaVersion: 1 as const,
      sequence,
      executionContextSha256: EXECUTION_CONTEXT_SHA256,
      activeTools: [...activeTools].sort(),
      worldState: {
        sandbox: { status: "inactive" as const, continuitySha256: null },
        environmentSha256: "c".repeat(64),
        committedWorkspaceRevision: null,
        toolPolicySha256: "d".repeat(64),
      },
    };
    return {
      step: {
        context,
        sha256: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
      },
      modelMessages: [],
    };
  };
}

async function captureContext(handlers: Map<string, (...args: never[]) => unknown>): Promise<void> {
  const handler = handlers.get("context");
  if (handler === undefined) throw new Error("Context handler was not installed");
  await handler({ type: "context", messages: [] } as never);
}

const BASE_CONFIGURATION = {
  operationUrl: "http://127.0.0.1:4999/v1/tool-operations",
  activationId: "10000000-0000-4000-8000-000000000001",
  capability: `adts_${"a".repeat(43)}`,
  executionContextSha256: EXECUTION_CONTEXT_SHA256,
  captureStepContext: createStepCapture(),
  remainingToolCalls: 0,
  maximumToolOutputBytes: 1_024,
  toolOutputDirectory: "/tmp/agent-dock-tool-output-test",
  traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
} as const;

function installInlineExtension(
  extension: ReturnType<typeof createTrustedRemoteToolsExtension>,
  pi: ExtensionAPI,
): void {
  if (typeof extension === "function") extension(pi);
  else extension.factory(pi);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trusted remote tools extension governance", () => {
  it("binds SDK tool identity from an activation-local object instead of process.env", () => {
    const registered: ToolDefinition[] = [];
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const extension = createTrustedRemoteToolsExtension({
      operationUrl: "http://127.0.0.1:4999/v1/tool-operations",
      activationId: "10000000-0000-4000-8000-000000000099",
      capability: `adts_${"z".repeat(43)}`,
      executionContextSha256: EXECUTION_CONTEXT_SHA256,
      captureStepContext: createStepCapture(),
      remainingToolCalls: 0,
      maximumToolOutputBytes: 1_024,
      toolOutputDirectory: "/tmp/agent-dock-sdk-tool-output-test",
      projectInstructions: "SDK activation-local instructions.",
    });
    if (typeof extension !== "function") throw new Error("Expected an inline extension factory");
    extension({
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        handlers.set(name, handler);
      },
      getActiveTools() {
        return [...ACTIVE_TOOLS];
      },
    } as unknown as ExtensionAPI);

    expect(registered.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);
    expect(registered.every((tool) => tool.executionMode === "sequential")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
  });

  it("rejects a Pi tool call before Tool RPC when the durable run budget is exhausted", async () => {
    const registered: ToolDefinition[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on() {},
    } as unknown as ExtensionAPI;
    installInlineExtension(createTrustedRemoteToolsExtension(BASE_CONFIGURATION), pi);
    expect(registered.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);
    await expect(
      registered
        .find((tool) => tool.name === "read")!
        .execute(
          "tool-call-1",
          { path: "README.md" },
          new AbortController().signal,
          () => undefined,
          undefined as never,
        ),
    ).rejects.toThrow("tool_budget_exhausted");
  });

  it("captures every Pi sampling boundary and binds Tool RPC to the latest Step", async () => {
    const registered: ToolDefinition[] = [];
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const capturedSteps: Array<ReturnType<ReturnType<typeof createStepCapture>>> = [];
    const capture = createStepCapture();
    const onToolOperationStarted = vi.fn();
    let requestBody: Record<string, unknown> | undefined;
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        handlers.set(name, handler);
      },
      getActiveTools() {
        return [...ACTIVE_TOOLS];
      },
    } as unknown as ExtensionAPI;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: requestBody.activationId,
          operationId: requestBody.operationId,
          operation: "bash.exec",
          exitCode: 0,
          outputChunks: [],
          outputSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    installInlineExtension(
      createTrustedRemoteToolsExtension({
        ...BASE_CONFIGURATION,
        remainingToolCalls: 2,
        captureStepContext: (activeTools) => {
          const captured = capture(activeTools);
          capturedSteps.push(captured);
          return captured;
        },
        onToolOperationStarted,
      }),
      pi,
    );

    await expect(
      registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-before-step",
          { command: "pwd", timeout: 10 },
          new AbortController().signal,
          () => undefined,
          undefined as never,
        ),
    ).rejects.toThrow("step_context_unavailable");
    await captureContext(handlers);
    await captureContext(handlers);
    await registered
      .find((tool) => tool.name === "bash")!
      .execute(
        "tool-call-after-step",
        { command: "pwd", timeout: 10 },
        new AbortController().signal,
        () => undefined,
        undefined as never,
      );

    expect(capturedSteps.map((entry) => entry.step.context.sequence)).toEqual([1, 2]);
    expect(requestBody).toMatchObject({
      executionContextSha256: EXECUTION_CONTEXT_SHA256,
      stepContextSequence: 2,
      stepContextSha256: capturedSteps[1]!.step.sha256,
    });
    expect(onToolOperationStarted).toHaveBeenCalledTimes(1);
  });

  it("injects one model-visible world-state delta at repeated context boundaries", async () => {
    const registered: ToolDefinition[] = [];
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const capture = createStepCapture();
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        handlers.set(name, handler);
      },
      getActiveTools() {
        return [...ACTIVE_TOOLS];
      },
    } as unknown as ExtensionAPI;
    installInlineExtension(
      createTrustedRemoteToolsExtension({
        ...BASE_CONFIGURATION,
        captureStepContext: (activeTools) => ({
          ...capture(activeTools),
          modelMessages: [
            {
              customType: "agent-dock.sandbox_reset",
              content: "<sandbox_reset>reset</sandbox_reset>",
              display: false,
              details: { schemaVersion: 1, changeSha256: "e".repeat(64) },
            },
          ],
        }),
      }),
      pi,
    );
    const handler = handlers.get("context");
    if (handler === undefined) throw new Error("Context handler was not installed");
    const first = (await handler({ type: "context", messages: [] } as never)) as {
      messages: unknown[];
    };
    const second = (await handler({ type: "context", messages: first.messages } as never)) as {
      messages: unknown[];
    };

    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
  });

  it("marks the Step world unavailable when Cube can no longer prove a Tool result", async () => {
    const registered: ToolDefinition[] = [];
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const onToolOperationUnavailable = vi.fn();
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        handlers.set(name, handler);
      },
      getActiveTools() {
        return [...ACTIVE_TOOLS];
      },
    } as unknown as ExtensionAPI;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "cubesandbox_tool_result_unknown",
              message: "The Cube operation ledger was lost",
              retryable: false,
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    installInlineExtension(
      createTrustedRemoteToolsExtension({
        ...BASE_CONFIGURATION,
        remainingToolCalls: 1,
        onToolOperationUnavailable,
      }),
      pi,
    );
    await captureContext(handlers);

    await expect(
      registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-unknown",
          { command: "migrate", timeout: 10 },
          new AbortController().signal,
          () => undefined,
          undefined as never,
        ),
    ).rejects.toThrow("cubesandbox_tool_result_unknown");
    expect(onToolOperationUnavailable).toHaveBeenCalledTimes(1);
  });

  it("layers bounded project instructions and preserves a large read result", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agent-dock-tool-output-extension-test-"));
    try {
      const registered: ToolDefinition[] = [];
      const handlers = new Map<string, (...args: never[]) => unknown>();
      const pi = {
        registerTool(tool: ToolDefinition) {
          registered.push(tool);
        },
        on(name: string, handler: (...args: never[]) => unknown) {
          handlers.set(name, handler);
        },
        getActiveTools() {
          return [...ACTIVE_TOOLS];
        },
      } as unknown as ExtensionAPI;
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("traceparent")).toBe(BASE_CONFIGURATION.traceparent);
        const request = JSON.parse(String(init.body)) as {
          activationId: string;
          operationId: string;
          operation: string;
          path?: string;
        };
        const common = {
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: request.operationId,
          operation: request.operation,
        };
        const body =
          request.operation === "file.read_range"
            ? {
                ...common,
                content: Buffer.from("x".repeat(2_048)).toString("base64"),
                startLine: 1,
                endLine: 1,
              }
            : common;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      installInlineExtension(
        createTrustedRemoteToolsExtension({
          ...BASE_CONFIGURATION,
          remainingToolCalls: 1,
          toolOutputDirectory: directory,
          projectInstructions: "Prefer deterministic tests.",
        }),
        pi,
      );
      const beforeAgentStart = handlers.get("before_agent_start");
      expect(beforeAgentStart).toBeDefined();
      const context = (await beforeAgentStart!({
        type: "before_agent_start",
        prompt: "fix it",
        systemPrompt: "Current working directory: /trusted",
        systemPromptOptions: {},
      } as never)) as { systemPrompt: string };
      expect(context.systemPrompt).toContain("Current working directory: /workspace");
      expect(context.systemPrompt).toContain("Prefer deterministic tests.");
      const beforeProviderHeaders = handlers.get("before_provider_headers");
      expect(beforeProviderHeaders).toBeDefined();
      const providerHeaders: Record<string, string | null> = {};
      await beforeProviderHeaders!({
        type: "before_provider_headers",
        headers: providerHeaders,
      } as never);
      expect(providerHeaders.traceparent).toBe(BASE_CONFIGURATION.traceparent);
      await captureContext(handlers);

      await registered
        .find((tool) => tool.name === "read")!
        .execute(
          "tool-call-large-read",
          { path: "large.txt" },
          new AbortController().signal,
          () => undefined,
          undefined as never,
        );
      const artifact = resolve(
        directory,
        `${createHash("sha256").update("tool-call-large-read").digest("hex")}.output`,
      );
      expect(await readFile(artifact)).toEqual(Buffer.from("x".repeat(2_048)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects one recoverable head-tail Bash preview from the original output", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agent-dock-bash-preview-test-"));
    try {
      const registered: ToolDefinition[] = [];
      const handlers = new Map<string, (...args: never[]) => unknown>();
      const original = Buffer.from(
        `BEGIN-${"a".repeat(2_000)}-MIDDLE-${"b".repeat(2_000)}-FINAL-COMPILER-ERROR`,
        "utf8",
      );
      const pi = {
        registerTool(tool: ToolDefinition) {
          registered.push(tool);
        },
        on(name: string, handler: (...args: never[]) => unknown) {
          handlers.set(name, handler);
        },
        getActiveTools() {
          return [...ACTIVE_TOOLS];
        },
      } as unknown as ExtensionAPI;
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          activationId: string;
          operationId: string;
          operation: string;
        };
        return new Response(
          JSON.stringify({
            managerProtocolVersion: 1,
            type: "tool_sandbox.operation_result",
            activationId: request.activationId,
            operationId: request.operationId,
            operation: "bash.exec",
            exitCode: 0,
            outputChunks: [
              { seq: 1, stream: "stdout", data: original.subarray(0, 700).toString("base64") },
              {
                seq: 2,
                stream: "stderr",
                data: original.subarray(700, 1_400).toString("base64"),
              },
              { seq: 3, stream: "stdout", data: original.subarray(1_400).toString("base64") },
            ],
            outputSha256: createHash("sha256").update(original).digest("hex"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      installInlineExtension(
        createTrustedRemoteToolsExtension({
          ...BASE_CONFIGURATION,
          remainingToolCalls: 1,
          toolOutputDirectory: directory,
        }),
        pi,
      );
      await captureContext(handlers);

      const result = (await registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-large-bash",
          { command: "compile", timeout: 10 },
          new AbortController().signal,
          () => undefined,
          undefined as never,
        )) as {
        content: Array<{ type: string; text: string }>;
        details?: { truncation?: unknown };
      };

      const preview = result.content[0]?.text ?? "";
      expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(1_024);
      expect(preview).toContain("BEGIN-");
      expect(preview).toContain("FINAL-COMPILER-ERROR");
      expect(preview).toContain("complete output is preserved as the tool-output artifact");
      expect(result.details?.truncation).toBeUndefined();
      const artifact = resolve(
        directory,
        `${createHash("sha256").update("tool-call-large-bash").digest("hex")}.output`,
      );
      expect(await readFile(artifact)).toEqual(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-contiguous Bash output before exposing it to Pi", async () => {
    const registered: ToolDefinition[] = [];
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        handlers.set(name, handler);
      },
      getActiveTools() {
        return [...ACTIVE_TOOLS];
      },
    } as unknown as ExtensionAPI;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        activationId: string;
        operationId: string;
      };
      return new Response(
        JSON.stringify({
          managerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: request.operationId,
          operation: "bash.exec",
          exitCode: 0,
          outputChunks: [
            { seq: 1, stream: "stdout", data: Buffer.from("first").toString("base64") },
            { seq: 3, stream: "stderr", data: Buffer.from("lost").toString("base64") },
          ],
          outputSha256: createHash("sha256").update("firstlost").digest("hex"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    installInlineExtension(
      createTrustedRemoteToolsExtension({
        ...BASE_CONFIGURATION,
        remainingToolCalls: 1,
      }),
      pi,
    );
    await captureContext(handlers);

    await expect(
      registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-invalid-output",
          { command: "compile", timeout: 10 },
          new AbortController().signal,
          () => undefined,
          undefined as never,
        ),
    ).rejects.toThrow("tool_output_sequence_invalid");
  });

  it("binds edit writes to the file revision that Pi actually read", async () => {
    const registered: ToolDefinition[] = [];
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const original = Buffer.from("before\n", "utf8");
    const originalSha256 = createHash("sha256").update(original).digest("hex");
    let written: string | undefined;
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        handlers.set(name, handler);
      },
      getActiveTools() {
        return [...ACTIVE_TOOLS];
      },
    } as unknown as ExtensionAPI;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        activationId: string;
        operationId: string;
        operation: string;
        content?: string;
        expectedSha256?: string;
      };
      const common = {
        managerProtocolVersion: 1,
        type: "tool_sandbox.operation_result",
        activationId: request.activationId,
        operationId: request.operationId,
        operation: request.operation,
      };
      if (request.operation === "file.read") {
        return new Response(
          JSON.stringify({
            ...common,
            content: original.toString("base64"),
            sha256: originalSha256,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (request.operation === "file.write") {
        expect(request.expectedSha256).toBe(originalSha256);
        written = request.content;
        return new Response(
          JSON.stringify({
            ...common,
            sha256: createHash("sha256").update(request.content!, "utf8").digest("hex"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(common), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    installInlineExtension(
      createTrustedRemoteToolsExtension({
        ...BASE_CONFIGURATION,
        remainingToolCalls: 1,
      }),
      pi,
    );
    await captureContext(handlers);

    await expect(
      registered
        .find((tool) => tool.name === "edit")!
        .execute(
          "tool-call-atomic-edit",
          { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
          new AbortController().signal,
          () => undefined,
          undefined as never,
        ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in example.txt." }],
    });
    expect(written).toBe("after\n");
  });
});
