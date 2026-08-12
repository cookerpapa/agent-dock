import type {
  AcceptedTurnResource,
  AgentDockEvent,
  ConversationDetailResource,
  ConversationSessionResource,
  LiveTurnSnapshotResource,
  ProjectResource,
  ProjectEnvironmentResource,
  RunResource,
  SessionState,
  SessionResource,
  WorkspacePatch,
} from "@agent-dock/protocol";
import type { SessionStreamStatus } from "./sse.ts";

type ApprovalPayload = Extract<AgentDockEvent, { type: "approval.requested" }>["payload"];

export type TurnViewStatus =
  "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export type TranscriptItem =
  | {
      kind: "text";
      key: string;
      text: string;
      firstSequence: number;
      lastSequence: number;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      inputJson?: string;
      output?: unknown;
      status: "preparing" | "running" | "completed" | "failed" | "unknown";
      firstSequence: number;
      lastSequence?: number;
      startedAt: string;
      completedAt?: string;
    }
  | {
      kind: "approval";
      key: string;
      approval: ApprovalPayload;
      outcome?: "approved" | "rejected" | "cancelled";
      value?: string;
      firstSequence: number;
      lastSequence?: number;
    }
  | {
      kind: "notification";
      key: string;
      level: "info" | "warning" | "error";
      message: string;
      sequence: number;
    };

export type TurnView = {
  runId: string | null;
  turnId: string;
  commandId: string | null;
  mailboxPosition: number | null;
  prompt: string;
  acceptedAt: string | null;
  projection: "canonical" | "superseded";
  supersededByRunId: string | null;
  rewoundFromRunId: string | null;
  status: TurnViewStatus;
  items: readonly TranscriptItem[];
  startedSequence: number | null;
  terminalSequence: number | null;
  stopReason: string | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  cancellation: { reason: string; forced: boolean } | null;
  workspacePatch: WorkspacePatch | null;
};

export type ConnectionView =
  | { phase: "offline"; attempt: 0; message: string | null }
  | {
      phase: SessionStreamStatus["phase"];
      attempt: number;
      message: string | null;
      retryInMs: number | null;
    };

export type SessionViewStatus = "none" | SessionState;

export type SessionViewState = {
  project: ProjectResource | null;
  session: SessionResource | ConversationSessionResource | null;
  sessionState: SessionViewStatus;
  lastSequence: number;
  turns: readonly TurnView[];
  historyTruncated: boolean;
  connection: ConnectionView;
  apiError: string | null;
};

export type SessionViewAction =
  | { type: "session.created"; project: ProjectResource; session: SessionResource }
  | {
      type: "conversation.loaded";
      conversation: ConversationDetailResource;
      liveSnapshot?: LiveTurnSnapshotResource;
    }
  | { type: "project.environment.refreshed"; environment: ProjectEnvironmentResource }
  | { type: "turn.accepted"; accepted: AcceptedTurnResource; prompt: string }
  | { type: "turn.cancellation.requested"; turnId: string }
  | {
      type: "run.reconciled";
      run: Pick<RunResource, "runId" | "state" | "stopReason" | "failure">;
    }
  | { type: "stream.status"; status: SessionStreamStatus }
  | { type: "stream.event"; event: AgentDockEvent }
  | { type: "api.error"; message: string }
  | { type: "api.error.cleared" };

export function createInitialSessionView(): SessionViewState {
  return {
    project: null,
    session: null,
    sessionState: "none",
    lastSequence: 0,
    turns: [],
    historyTruncated: false,
    connection: { phase: "offline", attempt: 0, message: null },
    apiError: null,
  };
}

function unknownTurn(turnId: string): TurnView {
  return {
    runId: null,
    turnId,
    commandId: null,
    mailboxPosition: null,
    prompt: "Input was accepted before this browser connected.",
    acceptedAt: null,
    projection: "canonical",
    supersededByRunId: null,
    rewoundFromRunId: null,
    status: "running",
    items: [],
    startedSequence: null,
    terminalSequence: null,
    stopReason: null,
    failure: null,
    cancellation: null,
    workspacePatch: null,
  };
}

function updateTurn(
  turns: readonly TurnView[],
  turnId: string,
  update: (turn: TurnView) => TurnView,
): readonly TurnView[] {
  const index = turns.findIndex((turn) => turn.turnId === turnId);
  if (index < 0) return [...turns, update(unknownTurn(turnId))];
  return turns.map((turn, current) => (current === index ? update(turn) : turn));
}

function appendText(turn: TurnView, text: string, sequence: number): TurnView {
  const items = [...turn.items];
  const last = items.at(-1);
  if (last?.kind === "text") {
    items[items.length - 1] = {
      ...last,
      text: `${last.text}${text}`,
      lastSequence: sequence,
    };
  } else {
    items.push({
      kind: "text",
      key: `text:${String(sequence)}`,
      text,
      firstSequence: sequence,
      lastSequence: sequence,
    });
  }
  return { ...turn, status: "running", items };
}

function transcriptItem(
  item: NonNullable<ConversationDetailResource["turns"][number]["transcript"]>["items"][number],
): TranscriptItem {
  if (item.kind === "text") {
    return { ...item, key: `text:${String(item.firstSequence)}` };
  }
  if (item.kind === "tool") {
    return { ...item, key: `tool:${item.toolCallId}` };
  }
  if (item.kind === "approval") {
    return { ...item, key: `approval:${item.approval.approvalId}` };
  }
  return { ...item, key: `notification:${String(item.sequence)}` };
}

function applyEvent(state: SessionViewState, event: AgentDockEvent): SessionViewState {
  if (state.session !== null && event.sessionId !== state.session.sessionId) return state;
  if (event.seq <= state.lastSequence) return state;
  if (event.seq !== state.lastSequence + 1) {
    return {
      ...state,
      connection: {
        phase: "failed",
        attempt: state.connection.attempt,
        message: `Event sequence jumped from ${String(state.lastSequence)} to ${String(event.seq)}`,
        retryInMs: null,
      },
      apiError: "The browser rejected a non-contiguous event stream.",
    };
  }

  const sequenced = { ...state, lastSequence: event.seq };
  if (event.type === "session.state.changed") {
    return { ...sequenced, sessionState: event.payload.to };
  }
  if (event.turnId === null) return sequenced;

  const turns = updateTurn(sequenced.turns, event.turnId, (turn) => {
    if (event.type === "turn.started") {
      return {
        ...turn,
        status: "running",
        startedSequence: event.seq,
        failure: null,
        cancellation: null,
      };
    }
    if (event.type === "assistant.text.delta") {
      return appendText(turn, event.payload.text, event.seq);
    }
    if (event.type === "tool.input.delta") {
      let matched = false;
      const items = turn.items.map((item): TranscriptItem => {
        if (item.kind !== "tool" || item.toolCallId !== event.payload.toolCallId) return item;
        matched = true;
        return {
          ...item,
          toolName: event.payload.toolName,
          inputJson: `${item.inputJson ?? ""}${event.payload.delta}`,
        };
      });
      if (!matched) {
        items.push({
          kind: "tool",
          key: `tool:${event.payload.toolCallId}`,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: null,
          inputJson: event.payload.delta,
          status: "preparing",
          firstSequence: event.seq,
          startedAt: event.occurredAt,
        });
      }
      return { ...turn, status: "running", items };
    }
    if (event.type === "tool.started") {
      let matched = false;
      const items = turn.items.map((item): TranscriptItem => {
        if (item.kind !== "tool" || item.toolCallId !== event.payload.toolCallId) return item;
        matched = true;
        return {
          ...item,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          startedAt: event.occurredAt,
        };
      });
      if (!matched) {
        items.push({
          kind: "tool",
          key: `tool:${event.payload.toolCallId}`,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          firstSequence: event.seq,
          startedAt: event.occurredAt,
        });
      }
      return {
        ...turn,
        status: "running",
        items,
      };
    }
    if (event.type === "tool.completed") {
      let matched = false;
      const items = turn.items.map((item): TranscriptItem => {
        if (item.kind !== "tool" || item.toolCallId !== event.payload.toolCallId) return item;
        matched = true;
        return {
          ...item,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          lastSequence: event.seq,
          completedAt: event.occurredAt,
        };
      });
      if (!matched) {
        items.push({
          kind: "tool",
          key: `tool:${event.payload.toolCallId}`,
          toolCallId: event.payload.toolCallId,
          toolName: "unknown",
          input: null,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          firstSequence: event.seq,
          lastSequence: event.seq,
          startedAt: event.occurredAt,
          completedAt: event.occurredAt,
        });
      }
      return { ...turn, items };
    }
    if (event.type === "approval.requested") {
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "approval",
            key: `approval:${event.payload.approvalId}`,
            approval: event.payload,
            firstSequence: event.seq,
          },
        ],
      };
    }
    if (event.type === "approval.resolved") {
      return {
        ...turn,
        items: turn.items.map((item): TranscriptItem =>
          item.kind === "approval" && item.approval.approvalId === event.payload.approvalId
            ? {
                ...item,
                outcome: event.payload.outcome,
                ...(event.payload.value === undefined ? {} : { value: event.payload.value }),
                lastSequence: event.seq,
              }
            : item,
        ),
      };
    }
    if (event.type === "ui.notification") {
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "notification",
            key: `notification:${String(event.seq)}`,
            level: event.payload.level,
            message: event.payload.message,
            sequence: event.seq,
          },
        ],
      };
    }
    if (event.type === "turn.completed") {
      return {
        ...turn,
        status: "completed",
        terminalSequence: event.seq,
        stopReason: event.payload.stopReason,
        workspacePatch: event.payload.workspacePatch ?? null,
      };
    }
    if (event.type === "turn.failed") {
      return {
        ...turn,
        items: turn.items.map((item): TranscriptItem =>
          item.kind === "tool" && (item.status === "preparing" || item.status === "running")
            ? { ...item, status: "unknown", lastSequence: event.seq, completedAt: event.occurredAt }
            : item,
        ),
        status: "failed",
        terminalSequence: event.seq,
        failure: event.payload,
      };
    }
    if (event.type === "turn.cancelled") {
      return {
        ...turn,
        items: turn.items.map((item): TranscriptItem =>
          item.kind === "tool" && (item.status === "preparing" || item.status === "running")
            ? { ...item, status: "unknown", lastSequence: event.seq, completedAt: event.occurredAt }
            : item,
        ),
        status: "cancelled",
        terminalSequence: event.seq,
        stopReason: "cancelled",
        cancellation: event.payload,
      };
    }
    return turn;
  });

  const terminal =
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled";
  return {
    ...sequenced,
    turns,
    sessionState: terminal
      ? "idle"
      : event.type === "turn.started"
        ? "running"
        : sequenced.sessionState,
  };
}

export function sessionViewReducer(
  state: SessionViewState,
  action: SessionViewAction,
): SessionViewState {
  if (action.type === "session.created") {
    return {
      ...createInitialSessionView(),
      project: action.project,
      session: action.session,
      sessionState: action.session.state,
      connection: { phase: "offline", attempt: 0, message: "Opening durable event stream" },
    };
  }
  if (action.type === "conversation.loaded") {
    const loaded: SessionViewState = {
      ...createInitialSessionView(),
      project: action.conversation.project,
      session: action.conversation.session,
      sessionState: action.conversation.session.state,
      lastSequence: action.conversation.replayAfterSequence,
      turns: action.conversation.turns.map((turn): TurnView => ({
        ...(turn.transcript === undefined
          ? {
              items: [],
              startedSequence: null,
              terminalSequence: null,
              stopReason: null,
              failure:
                turn.state === "failed"
                  ? {
                      code: "run_failed",
                      message: "这次运行失败了，请重试。",
                      retryable: true,
                    }
                  : null,
              cancellation:
                turn.state === "cancelled" ? { reason: "cancelled", forced: false } : null,
              workspacePatch: null,
            }
          : {
              items: turn.transcript.items.map(transcriptItem),
              startedSequence: turn.transcript.startedSequence,
              terminalSequence: turn.transcript.terminalSequence,
              stopReason: turn.transcript.stopReason,
              failure: turn.transcript.failure,
              cancellation: turn.transcript.cancellation,
              workspacePatch: turn.transcript.workspacePatch,
            }),
        runId: turn.runId,
        turnId: turn.turnId,
        commandId: turn.commandId,
        mailboxPosition: turn.mailboxPosition,
        prompt: turn.prompt,
        acceptedAt: turn.acceptedAt,
        projection: turn.projection,
        supersededByRunId: turn.supersededByRunId ?? null,
        rewoundFromRunId: turn.rewoundFromRunId ?? null,
        status:
          turn.state === "queued" || turn.state === "dispatching"
            ? "queued"
            : turn.state === "waiting_approval"
              ? "running"
              : turn.state,
      })),
      historyTruncated: action.conversation.historyTruncated,
      connection: { phase: "offline", attempt: 0, message: "Opening durable event stream" },
    };
    const snapshot = action.liveSnapshot;
    if (
      snapshot?.turn === null ||
      snapshot === undefined ||
      snapshot.sessionId !== action.conversation.session.sessionId ||
      snapshot.replayAfterSequence < loaded.lastSequence
    ) {
      return loaded;
    }
    const transcript = snapshot.turn.transcript;
    return {
      ...loaded,
      lastSequence: snapshot.replayAfterSequence,
      // Another tab can submit a Turn between the canonical conversation read
      // and this snapshot read. Preserve the live prefix even when that Turn
      // was not present in the earlier response.
      turns: updateTurn(loaded.turns, snapshot.turn.turnId, (turn): TurnView => {
        return {
          ...turn,
          items: transcript.items.map(transcriptItem),
          startedSequence: transcript.startedSequence,
          terminalSequence: transcript.terminalSequence,
          stopReason: transcript.stopReason,
          failure: transcript.failure,
          cancellation: transcript.cancellation,
          workspacePatch: transcript.workspacePatch,
          status:
            transcript.failure !== null
              ? "failed"
              : transcript.cancellation !== null
                ? "cancelled"
                : transcript.terminalSequence !== null
                  ? "completed"
                  : "running",
        };
      }),
    };
  }
  if (action.type === "project.environment.refreshed") {
    return state.project === null
      ? state
      : { ...state, project: { ...state.project, environment: action.environment } };
  }
  if (action.type === "turn.accepted") {
    const turns = updateTurn(state.turns, action.accepted.turnId, (turn) => ({
      ...turn,
      runId: action.accepted.runId,
      commandId: action.accepted.commandId,
      mailboxPosition: action.accepted.mailboxPosition,
      prompt: action.prompt,
      acceptedAt: action.accepted.acceptedAt,
      projection: "canonical",
      supersededByRunId: null,
      rewoundFromRunId: null,
      status: turn.startedSequence === null ? "queued" : turn.status,
    }));
    return { ...state, turns, apiError: null };
  }
  if (action.type === "run.reconciled") {
    const turns = state.turns.map((turn): TurnView => {
      if (turn.runId !== action.run.runId) return turn;
      if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
        return turn;
      }
      if (action.run.state === "completed") {
        return {
          ...turn,
          status: "completed",
          stopReason: action.run.stopReason ?? "stop",
        };
      }
      if (action.run.state === "cancelled") {
        return {
          ...turn,
          status: "cancelled",
          stopReason: "cancelled",
          cancellation: { reason: "cancelled", forced: false },
        };
      }
      if (
        action.run.state === "failed" ||
        action.run.state === "timed_out" ||
        action.run.state === "superseded"
      ) {
        return {
          ...turn,
          status: "failed",
          failure:
            action.run.failure === undefined
              ? action.run.state === "timed_out"
                ? { code: "run_timed_out", message: "运行超时，请重试。", retryable: true }
                : { code: "run_failed", message: "这次运行失败了，请重试。", retryable: true }
              : {
                  ...action.run.failure,
                  message: action.run.failure.message ?? "这次运行失败了，请重试。",
                },
        };
      }
      if (action.run.state === "cancel_requested") return { ...turn, status: "cancelling" };
      if (action.run.state === "running" || action.run.state === "checkpointing") {
        return { ...turn, status: "running" };
      }
      return { ...turn, status: "queued" };
    });
    const hasActiveTurn = turns.some(
      (turn) =>
        turn.status === "queued" || turn.status === "running" || turn.status === "cancelling",
    );
    return {
      ...state,
      turns,
      sessionState: hasActiveTurn ? state.sessionState : "idle",
    };
  }
  if (action.type === "turn.cancellation.requested") {
    return {
      ...state,
      turns: updateTurn(state.turns, action.turnId, (turn) => ({
        ...turn,
        status: turn.status === "running" ? "cancelling" : turn.status,
      })),
      apiError: null,
    };
  }
  if (action.type === "stream.status") {
    return {
      ...state,
      connection: {
        phase: action.status.phase,
        attempt: action.status.attempt,
        message: action.status.message ?? null,
        retryInMs: action.status.retryInMs ?? null,
      },
    };
  }
  if (action.type === "stream.event") return applyEvent(state, action.event);
  if (action.type === "api.error") return { ...state, apiError: action.message };
  return { ...state, apiError: null };
}

export function activeTurn(state: SessionViewState): TurnView | undefined {
  return state.turns.find(
    (turn) => turn.status === "queued" || turn.status === "running" || turn.status === "cancelling",
  );
}
