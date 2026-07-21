import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import trustedRemoteTools from "../src/trusted-remote-tools-extension.ts";

const ENVIRONMENT = {
  AGENT_DOCK_TRUSTED_TOOL_OPERATION_URL: "http://127.0.0.1:4999/v1/tool-operations",
  AGENT_DOCK_TRUSTED_TOOL_ACTIVATION_ID: "10000000-0000-4000-8000-000000000001",
  AGENT_DOCK_TRUSTED_TOOL_CAPABILITY: `adts_${"a".repeat(43)}`,
  AGENT_DOCK_TRUSTED_REMAINING_TOOL_CALLS: "0",
  AGENT_DOCK_TRUSTED_MAXIMUM_TOOL_OUTPUT_BYTES: "1024",
  AGENT_DOCK_TRUSTED_TOOL_OUTPUT_DIRECTORY: "/tmp/agent-dock-tool-output-test",
  AGENT_DOCK_TRUSTED_TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
} as const;

const original = new Map<string, string | undefined>();

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  original.clear();
});

describe("trusted remote tools extension governance", () => {
  it("rejects a Pi tool call before RPC when the durable run budget is exhausted", async () => {
    for (const [name, value] of Object.entries(ENVIRONMENT)) {
      original.set(name, process.env[name]);
      process.env[name] = value;
    }
    const registered: ToolDefinition[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool);
      },
      on() {},
    } as unknown as ExtensionAPI;
    trustedRemoteTools(pi);
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

  it("layers bounded project instructions and preserves a large read result", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agent-dock-tool-output-extension-test-"));
    try {
      for (const [name, value] of Object.entries({
        ...ENVIRONMENT,
        AGENT_DOCK_TRUSTED_REMAINING_TOOL_CALLS: "1",
        AGENT_DOCK_TRUSTED_TOOL_OUTPUT_DIRECTORY: directory,
        AGENT_DOCK_TRUSTED_PROJECT_INSTRUCTIONS_BASE64: Buffer.from(
          "Prefer deterministic tests.",
        ).toString("base64"),
      })) {
        original.set(name, process.env[name]);
        process.env[name] = value;
      }
      const registered: ToolDefinition[] = [];
      const handlers = new Map<string, (...args: never[]) => unknown>();
      const pi = {
        registerTool(tool: ToolDefinition) {
          registered.push(tool);
        },
        on(name: string, handler: (...args: never[]) => unknown) {
          handlers.set(name, handler);
        },
      } as unknown as ExtensionAPI;
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("traceparent")).toBe(
          ENVIRONMENT.AGENT_DOCK_TRUSTED_TRACEPARENT,
        );
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
          request.operation === "file.read"
            ? {
                ...common,
                content: Buffer.from("x".repeat(2_048)).toString("base64"),
              }
            : common;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      trustedRemoteTools(pi);
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
      expect(providerHeaders.traceparent).toBe(ENVIRONMENT.AGENT_DOCK_TRUSTED_TRACEPARENT);

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
});
