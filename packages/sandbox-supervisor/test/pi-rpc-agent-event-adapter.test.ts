import { createAgentDockEventFactory } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { PiRpcAgentEventAdapter } from "../src/index.ts";

function createAdapter() {
  let eventIndex = 0;
  const eventIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  return new PiRpcAgentEventAdapter(
    createAgentDockEventFactory(
      { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
      {
        initialSequence: 10,
        clock: () => new Date("2026-07-18T08:00:00.000Z"),
        idGenerator: () => eventIds[eventIndex++]!,
      },
    ),
    { inputKind: "prompt" },
  );
}

describe("PiRpcAgentEventAdapter", () => {
  it("maps a complete Pi text run without exposing raw Pi objects", () => {
    const adapter = createAdapter();
    const started = adapter.adapt({ type: "agent_start" });
    const delta = adapter.adapt({
      type: "message_update",
      message: { role: "assistant", providerSecret: "must-not-pass" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: { providerSecret: "must-not-pass" },
      },
    });
    adapter.adapt({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", errorMessage: "must-not-pass" },
    });
    const settled = adapter.adapt({ type: "agent_settled" });

    expect(started).toMatchObject({
      kind: "mapped",
      terminal: false,
      event: { seq: 11, type: "turn.started", payload: { inputKind: "prompt" } },
    });
    expect(delta).toMatchObject({
      kind: "mapped",
      event: { seq: 12, type: "assistant.text.delta", payload: { text: "hello" } },
    });
    expect(settled).toMatchObject({
      kind: "mapped",
      terminal: true,
      event: { seq: 13, type: "turn.completed", payload: { stopReason: "stop" } },
    });
    expect(JSON.stringify([started, delta, settled])).not.toContain("must-not-pass");
  });

  it("maps provider failure to a safe terminal event", () => {
    const adapter = createAdapter();
    adapter.adapt({ type: "agent_start" });
    adapter.adapt({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "https://secret.invalid?token=must-not-pass",
      },
    });
    const settled = adapter.adapt({ type: "agent_settled" });

    expect(settled).toMatchObject({
      kind: "mapped",
      terminal: true,
      event: {
        type: "turn.failed",
        payload: { code: "model_error", message: "Model request failed", retryable: true },
      },
    });
    expect(JSON.stringify(settled)).not.toContain("must-not-pass");
  });

  it("maps tool boundaries and rejects unknown Pi events", () => {
    const adapter = createAdapter();
    adapter.adapt({ type: "agent_start" });

    expect(
      adapter.adapt({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "README.md" },
      }),
    ).toMatchObject({ kind: "mapped", event: { type: "tool.started" } });
    expect(
      adapter.adapt({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: "ok" },
        isError: false,
      }),
    ).toMatchObject({ kind: "mapped", event: { type: "tool.completed" } });
    expect(adapter.adapt({ type: "future_pi_event", raw: "must-not-pass" })).toEqual({
      kind: "invalid",
      sourceType: "future_pi_event",
      reason: "No reviewed AgentDock v1 mapping exists for this Pi event type",
    });
  });
});
