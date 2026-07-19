import type {
  AcceptedTurnResource,
  AgentDockEvent,
  ProjectResource,
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
      output?: unknown;
      status: "running" | "completed" | "failed";
      firstSequence: number;
      lastSequence?: number;
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
  turnId: string;
  commandId: string | null;
  mailboxPosition: number | null;
  prompt: string;
  acceptedAt: string | null;
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
  session: SessionResource | null;
  sessionState: SessionViewStatus;
  lastSequence: number;
  turns: readonly TurnView[];
  connection: ConnectionView;
  apiError: string | null;
};

export type SessionViewAction =
  | { type: "session.created"; project: ProjectResource; session: SessionResource }
  | { type: "turn.accepted"; accepted: AcceptedTurnResource; prompt: string }
  | { type: "turn.cancellation.requested"; turnId: string }
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
    connection: { phase: "offline", attempt: 0, message: null },
    apiError: null,
  };
}

function unknownTurn(turnId: string): TurnView {
  return {
    turnId,
    commandId: null,
    mailboxPosition: null,
    prompt: "Input was accepted before this browser connected.",
    acceptedAt: null,
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
    if (event.type === "tool.started") {
      return {
        ...turn,
        status: "running",
        items: [
          ...turn.items,
          {
            kind: "tool",
            key: `tool:${event.payload.toolCallId}`,
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            input: event.payload.input,
            status: "running",
            firstSequence: event.seq,
          },
        ],
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
          status: event.payload.isError ? "failed" : "completed",
          lastSequence: event.seq,
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
          status: event.payload.isError ? "failed" : "completed",
          firstSequence: event.seq,
          lastSequence: event.seq,
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
        status: "failed",
        terminalSequence: event.seq,
        failure: event.payload,
      };
    }
    if (event.type === "turn.cancelled") {
      return {
        ...turn,
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
  if (action.type === "turn.accepted") {
    const turns = updateTurn(state.turns, action.accepted.turnId, (turn) => ({
      ...turn,
      commandId: action.accepted.commandId,
      mailboxPosition: action.accepted.mailboxPosition,
      prompt: action.prompt,
      acceptedAt: action.accepted.acceptedAt,
      status: turn.startedSequence === null ? "queued" : turn.status,
    }));
    return { ...state, turns, apiError: null };
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
