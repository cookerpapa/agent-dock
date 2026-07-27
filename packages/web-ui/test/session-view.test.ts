import type {
  AcceptedTurnResource,
  AgentDockEvent,
  ConversationDetailResource,
  ProjectResource,
  SessionResource,
} from "@agent-dock/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import {
  activeTurn,
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
  source: { kind: "sample_java", status: "ready" },
  environment: {
    environmentVersionId: "30000000-0000-4000-8000-000000000002",
    versionNumber: 1,
    profileKey: "agent-dock-fullstack",
    profileVersion: "1",
    imageRevision: "development",
    specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
    recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
    recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    state: "pending",
    active: true,
    createdAt: CREATED_AT,
  },
};

const session: SessionResource = {
  sessionId: SESSION_ID,
  title: "修复订单服务",
  projectId: project.projectId,
  workspaceId: project.workspaceId,
  state: "cold",
  modelProfileId: "50000000-0000-4000-8000-000000000001",
  createdAt: CREATED_AT,
};

const accepted: AcceptedTurnResource = {
  turnId: TURN_ID,
  sessionId: SESSION_ID,
  runId: "50000000-0000-4000-8000-000000000002",
  commandId: "60000000-0000-4000-8000-000000000001",
  mailboxPosition: 1,
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
  it("keeps durable mailbox positions for queued follow-ups", () => {
    const state = sessionViewReducer(preparedState(), {
      type: "turn.accepted",
      accepted: {
        ...accepted,
        turnId: "20000000-0000-4000-8000-000000000002",
        commandId: "60000000-0000-4000-8000-000000000002",
        mailboxPosition: 2,
      },
      prompt: "Run the follow-up checks",
    });

    expect(state.turns.map((turn) => [turn.mailboxPosition, turn.prompt, turn.status])).toEqual([
      [1, "Repair the test", "queued"],
      [2, "Run the follow-up checks", "queued"],
    ]);
    expect(activeTurn(state)?.mailboxPosition).toBe(1);
  });

  it("loads bounded historical prompt metadata before replaying its durable suffix", () => {
    const conversation: ConversationDetailResource = {
      project,
      session: {
        ...session,
        state: "running",
        updatedAt: CREATED_AT,
        lastActiveAt: CREATED_AT,
      },
      turns: [
        {
          turnId: TURN_ID,
          runId: accepted.runId,
          commandId: accepted.commandId,
          mailboxPosition: 8,
          prompt: "Historical private prompt",
          state: "running",
          projection: "canonical",
          acceptedAt: CREATED_AT,
        },
      ],
      historyTruncated: true,
      replayAfterSequence: 10,
    };
    let state = sessionViewReducer(createInitialSessionView(), {
      type: "conversation.loaded",
      conversation,
    });
    expect(state).toMatchObject({
      lastSequence: 10,
      sessionState: "running",
      historyTruncated: true,
      turns: [{ prompt: "Historical private prompt", mailboxPosition: 8, status: "running" }],
    });
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(11, { type: "assistant.text.delta", payload: { text: "continued" } }),
    });
    expect(state.lastSequence).toBe(11);
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({ kind: "text", text: "continued" }),
    ]);
  });

  it("hydrates a completed semantic transcript without replaying historical deltas", () => {
    const conversation: ConversationDetailResource = {
      project,
      session: {
        ...session,
        state: "idle",
        updatedAt: CREATED_AT,
        lastActiveAt: CREATED_AT,
      },
      turns: [
        {
          turnId: TURN_ID,
          runId: accepted.runId,
          commandId: accepted.commandId,
          mailboxPosition: 1,
          prompt: "Historical projected prompt",
          state: "completed",
          projection: "canonical",
          transcript: {
            schemaVersion: 1,
            throughSequence: 6,
            items: [
              {
                kind: "text",
                text: "Inspecting tests.",
                firstSequence: 2,
                lastSequence: 3,
              },
              {
                kind: "tool",
                toolCallId: "call-1",
                toolName: "bash",
                input: { command: "npm test" },
                output: "all green",
                status: "completed",
                firstSequence: 4,
                lastSequence: 5,
                startedAt: CREATED_AT,
                completedAt: CREATED_AT,
              },
            ],
            startedSequence: 1,
            terminalSequence: 6,
            stopReason: "stop",
            failure: null,
            cancellation: null,
            workspacePatch: null,
          },
          acceptedAt: CREATED_AT,
        },
      ],
      historyTruncated: false,
      replayAfterSequence: 6,
    };
    const state = sessionViewReducer(createInitialSessionView(), {
      type: "conversation.loaded",
      conversation,
    });

    expect(state.lastSequence).toBe(6);
    expect(state.turns[0]).toMatchObject({
      status: "completed",
      startedSequence: 1,
      terminalSequence: 6,
      stopReason: "stop",
      items: [
        { kind: "text", key: "text:2", text: "Inspecting tests." },
        { kind: "tool", key: "tool:call-1", output: "all green" },
      ],
    });
  });

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
        startedAt: CREATED_AT,
        completedAt: CREATED_AT,
      }),
    ]);
    expect(
      sessionViewReducer(state, { type: "stream.event", event: events[5] as AgentDockEvent }),
    ).toBe(state);
  });

  it("assembles streamed tool input before execution and reconciles it with tool.started", () => {
    const events: AgentDockEvent[] = [
      envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
      envelope(2, {
        type: "tool.input.delta",
        payload: {
          toolCallId: "write-1",
          toolName: "write",
          delta: '{"path":"bubble_sort.py","content":"def ',
        },
      }),
      envelope(3, {
        type: "tool.input.delta",
        payload: { toolCallId: "write-1", toolName: "write", delta: 'bubble_sort():\\n"}' },
      }),
    ];
    let state = events.reduce(
      (current, value) => sessionViewReducer(current, { type: "stream.event", event: value }),
      preparedState(),
    );

    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "write-1",
        status: "preparing",
        inputJson: '{"path":"bubble_sort.py","content":"def bubble_sort():\\n"}',
        firstSequence: 2,
      }),
    ]);

    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(4, {
        type: "tool.started",
        payload: {
          toolCallId: "write-1",
          toolName: "write",
          input: { path: "bubble_sort.py", content: "def bubble_sort():\n" },
        },
      }),
    });
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({
        kind: "tool",
        status: "running",
        input: { path: "bubble_sort.py", content: "def bubble_sort():\n" },
        inputJson: '{"path":"bubble_sort.py","content":"def bubble_sort():\\n"}',
        firstSequence: 2,
      }),
    ]);
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

  it("reconciles a provisioning failure even when no session event was published", () => {
    const state = sessionViewReducer(preparedState(), {
      type: "run.reconciled",
      run: {
        runId: accepted.runId,
        state: "failed",
        failure: {
          code: "workspace_seed_unavailable",
          message: "Workspace source could not be provisioned",
          retryable: true,
        },
      },
    });

    expect(activeTurn(state)).toBeUndefined();
    expect(state.sessionState).toBe("idle");
    expect(state.turns[0]).toMatchObject({
      runId: accepted.runId,
      status: "failed",
      failure: { code: "workspace_seed_unavailable" },
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
