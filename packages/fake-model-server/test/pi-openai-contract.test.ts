import {
  Type,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { completeSimple, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FAKE_MODEL_API_KEY,
  FAKE_MODEL_ID,
  FakeModelServer,
  type FakeModelScenario,
} from "../src/index.ts";

let server: FakeModelServer;
let model: Model<"openai-completions">;

const userContext: Context = {
  messages: [
    {
      role: "user",
      content: "Exercise the deterministic provider contract.",
      timestamp: 1_700_000_000_000,
    },
  ],
};

const inspectWorkspaceTool: Tool = {
  name: "inspect_workspace",
  description: "Inspect a workspace path",
  parameters: Type.Object({
    path: Type.String(),
  }),
};

const javaRepairTools: Tool[] = [
  {
    name: "bash",
    description: "Run a command",
    parameters: Type.Object({ command: Type.String() }),
  },
  {
    name: "edit",
    description: "Edit a file",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String(),
          newText: Type.String(),
        }),
      ),
    }),
  },
];

beforeAll(async () => {
  server = new FakeModelServer();
  await server.start();
  model = {
    id: FAKE_MODEL_ID,
    name: "AgentDock deterministic fake",
    api: "openai-completions",
    provider: "agent-dock-fake",
    baseUrl: server.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 16_384,
    maxTokens: 1_024,
    compat: {
      supportsUsageInStreaming: true,
    },
  };
});

afterAll(async () => {
  await server.stop();
});

function optionsFor(
  scenario: FakeModelScenario,
  overrides: Partial<SimpleStreamOptions> = {},
): SimpleStreamOptions {
  return {
    apiKey: FAKE_MODEL_API_KEY,
    cacheRetention: "none",
    headers: { "x-agent-dock-scenario": scenario },
    maxRetries: 0,
    timeoutMs: 1_000,
    ...overrides,
  };
}

async function completeScenario(
  scenario: FakeModelScenario,
  context: Context = userContext,
  overrides: Partial<SimpleStreamOptions> = {},
): Promise<AssistantMessage> {
  return completeSimple(model, context, optionsFor(scenario, overrides));
}

describe("pinned Pi OpenAI adapter contract", () => {
  it("parses deterministic text deltas, finish reason, response ID, and usage", async () => {
    const stream = streamSimple(model, userContext, optionsFor("text"));
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result.stopReason).toBe("stop");
    expect(result.responseId).toMatch(/^chatcmpl-agentdock-/);
    expect(result.content).toEqual([{ type: "text", text: "AgentDock fake stream OK." }]);
    expect(result.usage).toMatchObject({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
    });
  });

  it("assembles fragmented tool arguments and completes after a tool result", async () => {
    const contextWithTool: Context = {
      ...userContext,
      tools: [inspectWorkspaceTool],
    };
    const first = await completeScenario("tool_call", contextWithTool);
    expect(first.stopReason).toBe("toolUse");
    expect(first.content).toEqual([
      {
        type: "toolCall",
        id: "call_agentdock_001",
        name: "inspect_workspace",
        arguments: { path: "src" },
      },
    ]);

    const toolCall = first.content[0];
    if (!toolCall || toolCall.type !== "toolCall") {
      throw new Error("Expected a parsed tool call");
    }
    const followUp: Context = {
      tools: [inspectWorkspaceTool],
      messages: [
        ...userContext.messages,
        first,
        {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "src contains index.ts" }],
          isError: false,
          timestamp: 1_700_000_001_000,
        },
      ],
    };
    const second = await completeScenario("tool_call", followUp);
    expect(second.stopReason).toBe("stop");
    expect(second.content).toEqual([{ type: "text", text: "Tool result accepted." }]);
  });

  it("drives the deterministic Java repair tool sequence", async () => {
    const messages: Context["messages"] = [...userContext.messages];
    const expectedTools = ["bash", "edit", "bash"];
    for (const expectedTool of expectedTools) {
      const assistant = await completeScenario("java_repair", {
        messages,
        tools: javaRepairTools,
      });
      expect(assistant.stopReason).toBe("toolUse");
      const toolCall = assistant.content[0];
      expect(toolCall).toMatchObject({ type: "toolCall", name: expectedTool });
      if (toolCall === undefined || toolCall.type !== "toolCall") {
        throw new Error("Expected the Java repair scenario to emit a tool call");
      }
      messages.push(assistant, {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "deterministic tool result" }],
        isError: false,
        timestamp: 1_700_000_001_000,
      });
    }

    const completion = await completeScenario("java_repair", {
      messages,
      tools: javaRepairTools,
    });
    expect(completion.stopReason).toBe("stop");
    expect(completion.content).toEqual([{ type: "text", text: "Java repair verified." }]);
  });

  it("emits a long-running bash call for active-tool cancellation acceptance", async () => {
    const assistant = await completeScenario("tool_hold", {
      ...userContext,
      tools: javaRepairTools,
    });
    expect(assistant.stopReason).toBe("toolUse");
    expect(assistant.content).toEqual([
      {
        type: "toolCall",
        id: "call_agentdock_cancellation_hold",
        name: "bash",
        arguments: { command: "exec sleep 300", timeout: 300 },
      },
    ]);
  });

  it("drives a prompt-selected coding evaluation without model nondeterminism", async () => {
    const messages: Context["messages"] = [
      {
        role: "user",
        content: "agent-dock-eval://factorial\nRepair factorial and run its focused test.",
        timestamp: 1_700_000_000_000,
      },
    ];
    for (const expected of ["bash", "edit", "bash"]) {
      const assistant = await completeScenario("coding_eval", {
        messages,
        tools: javaRepairTools,
      });
      const call = assistant.content[0];
      expect(call).toMatchObject({ type: "toolCall", name: expected });
      if (call === undefined || call.type !== "toolCall") throw new Error("Expected tool call");
      if (expected === "edit") {
        expect(call.arguments).toMatchObject({
          path: "src/Calculator.java",
          edits: [{ oldText: expect.stringContaining("factorial") }],
        });
      }
      messages.push(assistant, {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "deterministic result" }],
        isError: false,
        timestamp: 1_700_000_001_000,
      });
    }
    const completion = await completeScenario("coding_eval", {
      messages,
      tools: javaRepairTools,
    });
    expect(completion.content).toEqual([
      { type: "text", text: "Coding evaluation task factorial repaired and verified." },
    ]);
  });

  it("uses prior conversation context before verifying a cold-restored Java workspace", async () => {
    const messages: Context["messages"] = [...userContext.messages];
    for (let index = 0; index < 3; index += 1) {
      const assistant = await completeScenario("java_repair", {
        messages,
        tools: javaRepairTools,
      });
      const toolCall = assistant.content[0];
      if (toolCall === undefined || toolCall.type !== "toolCall") {
        throw new Error("Expected the Java repair scenario to emit a tool call");
      }
      messages.push(assistant, {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "deterministic tool result" }],
        isError: false,
        timestamp: 1_700_000_001_000 + index,
      });
    }
    messages.push(await completeScenario("java_repair", { messages, tools: javaRepairTools }), {
      role: "user",
      content: "Verify the previous repair after cold activation.",
      timestamp: 1_700_000_010_000,
    });

    const verification = await completeScenario("java_followup", {
      messages,
      tools: javaRepairTools,
    });
    expect(verification.stopReason).toBe("toolUse");
    expect(verification.content[0]).toMatchObject({
      type: "toolCall",
      name: "bash",
      arguments: { command: expect.stringContaining("return left + right;") },
    });
    const toolCall = verification.content[0];
    if (toolCall === undefined || toolCall.type !== "toolCall") {
      throw new Error("Expected the follow-up scenario to emit a tool call");
    }
    messages.push(verification, {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Calculator tests passed" }],
      isError: false,
      timestamp: 1_700_000_011_000,
    });
    const completion = await completeScenario("java_followup", {
      messages,
      tools: javaRepairTools,
    });
    expect(completion.content).toEqual([
      { type: "text", text: "Prior conversation and Java repair restored after cold activation." },
    ]);
  });

  it("surfaces the deterministic 429 without retrying", async () => {
    const requestCountBefore = server.observations.length;
    const result = await completeScenario("rate_limit");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/429|rate.?limit/i);
    expect(server.observations).toHaveLength(requestCountBefore + 1);
    expect(server.observations.at(-1)).toMatchObject({
      scenario: "rate_limit",
      responseStatus: 429,
    });
  });

  it("maps an HTTP request timeout to a provider error and closes the request", async () => {
    const startedAt = Date.now();
    const result = await completeScenario("timeout", userContext, { timeoutMs: 75 });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/timed?\s*out|timeout/i);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await waitFor(() => server.activeRequests === 0);
    expect(server.observations.at(-1)?.completion).toBe("client_aborted");
  });

  it("maps an explicit AbortSignal to an aborted assistant result", async () => {
    const controller = new AbortController();
    const stream = streamSimple(
      model,
      userContext,
      optionsFor("timeout", { signal: controller.signal, timeoutMs: 5_000 }),
    );
    await waitFor(() => server.activeRequests === 1);
    controller.abort();
    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toMatch(/abort/i);
    await waitFor(() => server.activeRequests === 0);
  });

  it("rejects malformed SSE JSON", async () => {
    const result = await completeScenario("malformed");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/json|parse|malformed|unexpected/i);
  });

  it("retains partial text but fails a stream disconnected before finish_reason", async () => {
    const result = await completeScenario("disconnect");
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([{ type: "text", text: "partial-before-disconnect" }]);
    expect(result.errorMessage).toMatch(/stream|connection|terminated|finish_reason|socket|fetch/i);
    expect(server.observations.at(-1)?.completion).toBe("server_disconnected");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fake model server state");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
