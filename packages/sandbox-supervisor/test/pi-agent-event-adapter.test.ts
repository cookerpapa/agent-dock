import { createAgentDockEventFactory } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { PiAgentEventAdapter } from "../src/index.ts";

function createAdapter() {
  let eventIndex = 0;
  const eventIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  return new PiAgentEventAdapter(
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

describe("PiAgentEventAdapter", () => {
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

  it("maps an expected Pi abort to a public cancellation instead of failure", () => {
    const adapter = createAdapter();
    adapter.adapt({ type: "agent_start" });
    adapter.requestCancellation("user_request");
    adapter.adapt({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted" },
    });

    expect(adapter.adapt({ type: "agent_settled" })).toMatchObject({
      kind: "mapped",
      terminal: true,
      event: {
        type: "turn.cancelled",
        payload: { reason: "user_request", forced: false },
      },
    });
  });

  it("can synthesize a forced cancellation when Pi does not settle", () => {
    const adapter = createAdapter();
    adapter.adapt({ type: "agent_start" });

    expect(adapter.forceCancellation("shutdown")).toMatchObject({
      kind: "mapped",
      terminal: true,
      event: { type: "turn.cancelled", payload: { reason: "shutdown", forced: true } },
    });
    expect(adapter.adapt({ type: "agent_settled" })).toMatchObject({ kind: "invalid" });
  });

  it("maps tool boundaries, reviews transient progress, and rejects unknown Pi events", () => {
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
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        partialResult: { content: "must-not-pass" },
      }),
    ).toEqual({ kind: "ignored", sourceType: "tool_execution_update" });
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

  it("coalesces tiny tool-call fragments and flushes the reviewed live input preview", () => {
    const adapter = createAdapter();
    adapter.adapt({ type: "agent_start" });

    const first = adapter.adapt({
      type: "message_update",
      message: { providerSecret: "must-not-pass" },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"bubble_sort.py",',
        partial: {
          providerSecret: "must-not-pass",
          content: [
            {
              type: "toolCall",
              id: "write-1",
              name: "write",
              arguments: { path: "bubble_sort.py" },
              providerSecret: "must-not-pass",
            },
          ],
        },
      },
    });
    expect(first).toEqual({
      kind: "ignored",
      sourceType: "message_update.toolcall_delta.buffered",
    });

    const body = `"content":"${"x".repeat(128)}`;
    const outcome = adapter.adapt({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: body,
        partial: {
          content: [
            {
              type: "toolCall",
              id: "write-1",
              name: "write",
              arguments: { path: "bubble_sort.py", content: "x".repeat(128) },
            },
          ],
        },
      },
    });

    expect(outcome).toMatchObject({
      kind: "mapped",
      event: {
        type: "tool.input.delta",
        payload: {
          toolCallId: "write-1",
          toolName: "write",
          delta: `{"path":"bubble_sort.py",${body}`,
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("must-not-pass");

    expect(
      adapter.adapt({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '"}',
          partial: {
            content: [
              {
                type: "toolCall",
                id: "write-1",
                name: "write",
                arguments: { path: "bubble_sort.py", content: "x".repeat(128) },
              },
            ],
          },
        },
      }),
    ).toEqual({ kind: "ignored", sourceType: "message_update.toolcall_delta.buffered" });

    const tail = adapter.adapt({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "write-1",
          name: "write",
          arguments: { path: "bubble_sort.py" },
        },
        partial: { content: [] },
      },
    });

    expect(tail).toMatchObject({
      kind: "mapped",
      event: {
        type: "tool.input.delta",
        payload: {
          toolCallId: "write-1",
          toolName: "write",
          delta: '"}',
        },
      },
    });
  });

  it("maps native Pi compaction without exposing its summary", () => {
    const adapter = createAdapter();
    adapter.adapt({ type: "agent_start" });
    expect(adapter.adapt({ type: "compaction_start", reason: "threshold" })).toMatchObject({
      kind: "mapped",
      event: { type: "context.compaction.started", payload: { reason: "threshold" } },
    });
    const completed = adapter.adapt({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "private compacted transcript",
        firstKeptEntryId: "entry-9",
        tokensBefore: 91_000,
        estimatedTokensAfter: 19_500,
      },
    });
    expect(completed).toMatchObject({
      kind: "mapped",
      event: {
        type: "context.compaction.completed",
        payload: {
          status: "completed",
          tokensBefore: 91_000,
          estimatedTokensAfter: 19_500,
          firstKeptEntryId: "entry-9",
          summarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
    expect(JSON.stringify(completed)).not.toContain("private compacted transcript");
  });

  it("bounds persisted tool output", () => {
    const adapter = new PiAgentEventAdapter(
      createAgentDockEventFactory(
        { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
        { idGenerator: () => "11111111-1111-4111-8111-111111111111" },
      ),
      { inputKind: "prompt", maximumToolOutputBytes: 1_024 },
    );
    const outcome = adapter.adapt({
      type: "tool_execution_end",
      toolCallId: "large",
      isError: false,
      result: "x".repeat(4_096),
    });
    expect(outcome).toMatchObject({
      kind: "mapped",
      event: { payload: { output: { truncated: true } } },
    });
    expect(Buffer.byteLength(JSON.stringify(outcome), "utf8")).toBeLessThan(1_500);
  });
});
