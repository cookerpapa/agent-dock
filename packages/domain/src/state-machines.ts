import { SessionStateSchema } from "@agent-dock/protocol";
import { Type, type Static } from "typebox";

export type SessionState = Static<typeof SessionStateSchema>;

export const TurnStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("dispatching"),
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("cancelling"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const SandboxStateSchema = Type.Union([
  Type.Literal("provisioning"),
  Type.Literal("ready"),
  Type.Literal("leased"),
  Type.Literal("draining"),
  Type.Literal("failed"),
  Type.Literal("terminated"),
]);

export const ApprovalStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("resolved"),
  Type.Literal("expired"),
  Type.Literal("cancelled"),
]);

export const AgentNodeStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("cancelling"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export type TurnState = Static<typeof TurnStateSchema>;
export type SandboxState = Static<typeof SandboxStateSchema>;
export type ApprovalState = Static<typeof ApprovalStateSchema>;
export type AgentNodeState = Static<typeof AgentNodeStateSchema>;

export type DomainEntityKind = "session" | "turn" | "sandbox" | "approval" | "agent_node";

type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

const sessionTransitions = {
  cold: ["starting"],
  starting: ["idle", "failed"],
  idle: ["running", "evicting", "failed"],
  running: ["idle", "waiting_approval", "cancelling", "failed"],
  waiting_approval: ["running", "cancelling", "failed"],
  cancelling: ["idle", "failed"],
  failed: ["recovering"],
  recovering: ["idle", "failed"],
  evicting: ["cold", "failed"],
} as const satisfies TransitionTable<SessionState>;

const turnTransitions = {
  queued: ["dispatching", "cancelling"],
  dispatching: ["queued", "running", "cancelling", "failed"],
  running: ["waiting_approval", "cancelling", "completed", "failed"],
  waiting_approval: ["running", "cancelling", "failed"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionTable<TurnState>;

const sandboxTransitions = {
  provisioning: ["ready", "failed", "terminated"],
  ready: ["leased", "draining", "failed"],
  leased: ["ready", "draining", "failed"],
  draining: ["terminated", "failed"],
  failed: ["terminated"],
  terminated: [],
} as const satisfies TransitionTable<SandboxState>;

const approvalTransitions = {
  pending: ["resolved", "expired", "cancelled"],
  resolved: [],
  expired: [],
  cancelled: [],
} as const satisfies TransitionTable<ApprovalState>;

const agentNodeTransitions = {
  pending: ["running", "cancelling", "failed"],
  running: ["waiting", "cancelling", "completed", "failed"],
  waiting: ["running", "cancelling", "completed", "failed"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionTable<AgentNodeState>;

export class DomainTransitionError extends Error {
  readonly entityKind: DomainEntityKind;
  readonly from: string;
  readonly to: string;

  constructor(entityKind: DomainEntityKind, from: string, to: string) {
    super(`Invalid ${entityKind} transition: ${from} -> ${to}`);
    this.name = "DomainTransitionError";
    this.entityKind = entityKind;
    this.from = from;
    this.to = to;
  }
}

function canTransition<State extends string>(
  table: TransitionTable<State>,
  from: State,
  to: State,
): boolean {
  return table[from].some((candidate) => candidate === to);
}

function transition<State extends string>(
  entityKind: DomainEntityKind,
  table: TransitionTable<State>,
  from: State,
  to: State,
): State {
  if (!canTransition(table, from, to)) {
    throw new DomainTransitionError(entityKind, from, to);
  }
  return to;
}

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return canTransition(sessionTransitions, from, to);
}

export function transitionSession(from: SessionState, to: SessionState): SessionState {
  return transition("session", sessionTransitions, from, to);
}

export function canTransitionTurn(from: TurnState, to: TurnState): boolean {
  return canTransition(turnTransitions, from, to);
}

export function transitionTurn(from: TurnState, to: TurnState): TurnState {
  return transition("turn", turnTransitions, from, to);
}

export function canTransitionSandbox(from: SandboxState, to: SandboxState): boolean {
  return canTransition(sandboxTransitions, from, to);
}

export function transitionSandbox(from: SandboxState, to: SandboxState): SandboxState {
  return transition("sandbox", sandboxTransitions, from, to);
}

export function canTransitionApproval(from: ApprovalState, to: ApprovalState): boolean {
  return canTransition(approvalTransitions, from, to);
}

export function transitionApproval(from: ApprovalState, to: ApprovalState): ApprovalState {
  return transition("approval", approvalTransitions, from, to);
}

export function canTransitionAgentNode(from: AgentNodeState, to: AgentNodeState): boolean {
  return canTransition(agentNodeTransitions, from, to);
}

export function transitionAgentNode(from: AgentNodeState, to: AgentNodeState): AgentNodeState {
  return transition("agent_node", agentNodeTransitions, from, to);
}

export function isTerminalTurnState(state: TurnState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function isTerminalApprovalState(state: ApprovalState): boolean {
  return state === "resolved" || state === "expired" || state === "cancelled";
}

export function isTerminalSandboxState(state: SandboxState): boolean {
  return state === "terminated";
}

export function isTerminalAgentNodeState(state: AgentNodeState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
