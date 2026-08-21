import { createPiCloudEventFactory, type PiCloudEventBody } from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import { projectConversationTurnTranscript } from "@pi-cloud/runtime-core/conversation-turn-projection";

const CREATED_AT = "2026-07-23T00:00:00.000Z";

function events(bodies: readonly PiCloudEventBody[]) {
  let id = 0;
  const factory = createPiCloudEventFactory(
    {
      sessionId: "10000000-0000-4000-8000-000000000001",
      turnId: "20000000-0000-4000-8000-000000000001",
      agentId: "root",
    },
    {
      clock: () => new Date(CREATED_AT),
      idGenerator: () => `30000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    },
  );
  return bodies.map((body) => factory.next(body));
}

describe("conversation turn projection", () => {
  it("coalesces text while preserving tool, approval, notification, and terminal semantics", () => {
    const projected = projectConversationTurnTranscript(
      events([
        { type: "turn.started", payload: { inputKind: "prompt" } },
        { type: "assistant.text.delta", payload: { text: "Inspecting " } },
        { type: "context.compaction.started", payload: { reason: "threshold" } },
        {
          type: "context.compaction.completed",
          payload: {
            reason: "threshold",
            status: "completed",
            willRetry: false,
            tokensBefore: 1_000,
            estimatedTokensAfter: 500,
          },
        },
        { type: "assistant.text.delta", payload: { text: "the tests." } },
        {
          type: "tool.started",
          payload: { toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } },
        },
        {
          type: "tool.completed",
          payload: { toolCallId: "call-1", outcome: "completed", output: "all green" },
        },
        { type: "assistant.text.delta", payload: { text: "Done." } },
        {
          type: "approval.requested",
          payload: {
            approvalId: "40000000-0000-4000-8000-000000000001",
            kind: "confirm",
            title: "Publish?",
            message: "Create the artifact",
          },
        },
        {
          type: "approval.resolved",
          payload: {
            approvalId: "40000000-0000-4000-8000-000000000001",
            outcome: "approved",
          },
        },
        {
          type: "ui.notification",
          payload: { level: "info", message: "Artifact ready" },
        },
        {
          type: "turn.completed",
          payload: {
            stopReason: "stop",
            workspacePatch: {
              format: "unified_diff",
              patch: "diff --git a/a b/a\n",
              truncated: false,
            },
          },
        },
      ]),
    );

    expect(projected).toMatchObject({
      schemaVersion: 1,
      throughSequence: 12,
      startedSequence: 1,
      terminalSequence: 12,
      stopReason: "stop",
      failure: null,
      cancellation: null,
      workspacePatch: { truncated: false },
    });
    expect(projected.items).toEqual([
      {
        kind: "text",
        text: "Inspecting the tests.",
        firstSequence: 2,
        lastSequence: 5,
      },
      {
        kind: "tool",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "npm test" },
        output: "all green",
        status: "completed",
        firstSequence: 6,
        lastSequence: 7,
        startedAt: CREATED_AT,
        completedAt: CREATED_AT,
      },
      {
        kind: "text",
        text: "Done.",
        firstSequence: 8,
        lastSequence: 8,
      },
      {
        kind: "approval",
        approval: {
          approvalId: "40000000-0000-4000-8000-000000000001",
          kind: "confirm",
          title: "Publish?",
          message: "Create the artifact",
        },
        outcome: "approved",
        firstSequence: 9,
        lastSequence: 10,
      },
      {
        kind: "notification",
        level: "info",
        message: "Artifact ready",
        sequence: 11,
      },
    ]);
  });

  it("rejects mixed identities instead of projecting ambiguous history", () => {
    const projectedEvents = events([
      { type: "turn.started", payload: { inputKind: "prompt" } },
      { type: "assistant.text.delta", payload: { text: "hello" } },
    ]);
    projectedEvents[1] = {
      ...projectedEvents[1]!,
      turnId: "20000000-0000-4000-8000-000000000002",
    };
    expect(() => projectConversationTurnTranscript(projectedEvents)).toThrow(/share one identity/);
  });

  it("collapses a high-frequency completed stream into one semantic text item", () => {
    const deltas: PiCloudEventBody[] = Array.from({ length: 1_000 }, () => ({
      type: "assistant.text.delta",
      payload: { text: "x" },
    }));
    const projected = projectConversationTurnTranscript(
      events([
        { type: "turn.started", payload: { inputKind: "prompt" } },
        ...deltas,
        { type: "turn.completed", payload: { stopReason: "stop" } },
      ]),
    );

    expect(projected.throughSequence).toBe(1_002);
    expect(projected.items).toEqual([
      {
        kind: "text",
        text: "x".repeat(1_000),
        firstSequence: 2,
        lastSequence: 1_001,
      },
    ]);
  });
});
