import type {
  AcceptedTurnResource,
  AgentDockEvent,
  ProjectResource,
  SessionResource,
} from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import {
  createInitialSessionView,
  sessionViewReducer,
  type SessionViewState,
} from "../src/session-view.ts";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const TURN_ID = "20000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-19T00:00:00.000Z";

const project: ProjectResource = {
  projectId: "30000000-0000-4000-8000-000000000001",
  workspaceId: "40000000-0000-4000-8000-000000000001",
  name: "Java repair demo",
  createdAt: CREATED_AT,
};

const session: SessionResource = {
  sessionId: SESSION_ID,
  projectId: project.projectId,
  workspaceId: project.workspaceId,
  state: "cold",
  modelProfileId: "50000000-0000-4000-8000-000000000001",
  createdAt: CREATED_AT,
};

const accepted: AcceptedTurnResource = {
  turnId: TURN_ID,
  sessionId: SESSION_ID,
  commandId: "60000000-0000-4000-8000-000000000001",
  state: "queued",
  acceptedAt: CREATED_AT,
  replayed: false,
};

function envelope<Event extends AgentDockEvent>(
  sequence: number,
  value: Omit<
    Event,
    "schemaVersion" | "eventId" | "sessionId" | "turnId" | "agentId" | "seq" | "occurredAt"
  > &
    Partial<Pick<Event, "turnId">>,
): AgentDockEvent {
  return {
    schemaVersion: 1,
    eventId: `70000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: SESSION_ID,
    turnId: value.turnId ?? TURN_ID,
    agentId: "root",
    seq: sequence,
    occurredAt: CREATED_AT,
    type: value.type,
    payload: value.payload,
  } as AgentDockEvent;
}

function preparedState(): SessionViewState {
  let state = sessionViewReducer(createInitialSessionView(), {
    type: "session.created",
    project,
    session,
  });
  state = sessionViewReducer(state, {
    type: "turn.accepted",
    accepted,
    prompt: "Repair the test",
  });
  return state;
}

describe("session transcript reducer", () => {
  it("keeps ordered text/tool lifecycle and the final bounded patch", () => {
    const events: AgentDockEvent[] = [
      envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
      envelope(2, { type: "assistant.text.delta", payload: { text: "Inspecting " } }),
      envelope(3, { type: "assistant.text.delta", payload: { text: "tests." } }),
      envelope(4, {
        type: "tool.started",
        payload: { toolCallId: "call-1", toolName: "bash", input: { command: "mvn test" } },
      }),
      envelope(5, {
        type: "tool.completed",
        payload: { toolCallId: "call-1", isError: false, output: "1 test failed" },
      }),
      envelope(6, {
        type: "turn.completed",
        payload: {
          stopReason: "stop",
          workspacePatch: {
            format: "unified_diff",
            patch: "diff --git a/App.java b/App.java\n",
            truncated: false,
          },
        },
      }),
    ];
    const state = events.reduce(
      (current, value) => sessionViewReducer(current, { type: "stream.event", event: value }),
      preparedState(),
    );

    expect(state.lastSequence).toBe(6);
    expect(state.sessionState).toBe("idle");
    expect(state.turns[0]).toMatchObject({
      status: "completed",
      stopReason: "stop",
      workspacePatch: { truncated: false },
    });
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "Inspecting tests.",
        firstSequence: 2,
        lastSequence: 3,
      }),
      expect.objectContaining({
        kind: "tool",
        toolName: "bash",
        status: "completed",
        firstSequence: 4,
        lastSequence: 5,
      }),
    ]);
    expect(
      sessionViewReducer(state, { type: "stream.event", event: events[5] as AgentDockEvent }),
    ).toBe(state);
  });

  it("marks cancellation intent before terminal confirmation", () => {
    let state = preparedState();
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
    });
    state = sessionViewReducer(state, {
      type: "turn.cancellation.requested",
      turnId: TURN_ID,
    });
    expect(state.turns[0]?.status).toBe("cancelling");
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(2, {
        type: "turn.cancelled",
        payload: { reason: "user_request", forced: false },
      }),
    });
    expect(state.turns[0]).toMatchObject({
      status: "cancelled",
      cancellation: { reason: "user_request", forced: false },
    });
  });

  it("refuses to render a sequence gap", () => {
    const state = sessionViewReducer(preparedState(), {
      type: "stream.event",
      event: envelope(2, { type: "assistant.text.delta", payload: { text: "gap" } }),
    });
    expect(state.lastSequence).toBe(0);
    expect(state.connection).toMatchObject({ phase: "failed" });
    expect(state.apiError).toMatch(/non-contiguous/);
  });

  it("ignores a late callback from a previously selected session", () => {
    const state = preparedState();
    const lateEvent = {
      ...envelope(1, { type: "assistant.text.delta", payload: { text: "late" } }),
      sessionId: "90000000-0000-4000-8000-000000000001",
    } as AgentDockEvent;
    expect(sessionViewReducer(state, { type: "stream.event", event: lateEvent })).toBe(state);
  });
});
