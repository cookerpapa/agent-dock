import { describe, expect, it } from "vitest";
import {
  DomainTransitionError,
  canTransitionCommand,
  canTransitionTurn,
  isTerminalAgentNodeState,
  isTerminalApprovalState,
  isTerminalCommandState,
  isTerminalSandboxState,
  isTerminalTurnState,
  transitionAgentNode,
  transitionApproval,
  transitionCommand,
  transitionSandbox,
  transitionSession,
  transitionTurn,
  type SessionState,
  type TurnState,
} from "../src/index.ts";

function walkSession(initial: SessionState, transitions: readonly SessionState[]): SessionState {
  return transitions.reduce((state, next) => transitionSession(state, next), initial);
}

function walkTurn(initial: TurnState, transitions: readonly TurnState[]): TurnState {
  return transitions.reduce((state, next) => transitionTurn(state, next), initial);
}

describe("domain state machines", () => {
  it("walks a session through activation, approval, cancellation, and eviction", () => {
    expect(
      walkSession("cold", ["starting", "idle", "running", "waiting_approval", "running", "idle"]),
    ).toBe("idle");
    expect(walkSession("idle", ["running", "cancelling", "idle", "evicting", "cold"])).toBe("cold");
  });

  it("requires explicit session recovery after a failure", () => {
    expect(walkSession("running", ["failed", "recovering", "idle"])).toBe("idle");
    expect(() => transitionSession("failed", "idle")).toThrow(DomainTransitionError);
    expect(() => transitionSession("cold", "running")).toThrow(
      "Invalid session transition: cold -> running",
    );
  });

  it("walks a turn through dispatch, approval, and completion", () => {
    const state = walkTurn("queued", [
      "dispatching",
      "running",
      "waiting_approval",
      "running",
      "completed",
    ]);
    expect(state).toBe("completed");
    expect(isTerminalTurnState(state)).toBe(true);
    expect(() => transitionTurn("completed", "running")).toThrow(DomainTransitionError);
  });

  it.each(["queued", "dispatching", "running", "waiting_approval"] as const)(
    "cancels a %s turn through an explicit cancelling state",
    (from) => {
      expect(transitionTurn(transitionTurn(from, "cancelling"), "cancelled")).toBe("cancelled");
    },
  );

  it("requeues only before execution has started after runner loss", () => {
    expect(canTransitionTurn("dispatching", "queued")).toBe(true);
    expect(transitionTurn("dispatching", "queued")).toBe("queued");
    expect(canTransitionTurn("running", "queued")).toBe(false);
    expect(() => transitionTurn("running", "queued")).toThrow(DomainTransitionError);
    expect(transitionTurn("running", "failed")).toBe("failed");
  });

  it("retries commands only before acknowledgement", () => {
    expect(transitionCommand("pending", "dispatched")).toBe("dispatched");
    expect(transitionCommand("dispatched", "pending")).toBe("pending");
    expect(canTransitionCommand("acknowledged", "pending")).toBe(false);
    expect(() => transitionCommand("acknowledged", "pending")).toThrow(DomainTransitionError);
  });

  it("makes completed and failed commands terminal", () => {
    expect(
      isTerminalCommandState(
        transitionCommand(transitionCommand("pending", "dispatched"), "acknowledged"),
      ),
    ).toBe(false);
    expect(isTerminalCommandState(transitionCommand("acknowledged", "completed"))).toBe(true);
    expect(isTerminalCommandState(transitionCommand("dispatched", "failed"))).toBe(true);
    expect(() => transitionCommand("completed", "failed")).toThrow(DomainTransitionError);
  });

  it("makes every approval outcome terminal", () => {
    for (const outcome of ["resolved", "expired", "cancelled"] as const) {
      expect(isTerminalApprovalState(transitionApproval("pending", outcome))).toBe(true);
      expect(() => transitionApproval(outcome, "resolved")).toThrow(DomainTransitionError);
    }
  });

  it("leases, drains, and permanently terminates a sandbox", () => {
    expect(transitionSandbox("provisioning", "ready")).toBe("ready");
    expect(transitionSandbox("ready", "leased")).toBe("leased");
    expect(transitionSandbox("leased", "ready")).toBe("ready");
    expect(transitionSandbox("ready", "draining")).toBe("draining");
    expect(isTerminalSandboxState(transitionSandbox("draining", "terminated"))).toBe(true);
    expect(() => transitionSandbox("terminated", "ready")).toThrow(DomainTransitionError);
  });

  it("allows failed sandbox cleanup without allowing reuse", () => {
    expect(transitionSandbox("leased", "failed")).toBe("failed");
    expect(transitionSandbox("failed", "terminated")).toBe("terminated");
    expect(() => transitionSandbox("failed", "ready")).toThrow(DomainTransitionError);
  });

  it("models agent waiting and cancellation without reviving terminal nodes", () => {
    expect(transitionAgentNode("pending", "running")).toBe("running");
    expect(transitionAgentNode("running", "waiting")).toBe("waiting");
    expect(transitionAgentNode("waiting", "running")).toBe("running");
    expect(transitionAgentNode("running", "completed")).toBe("completed");
    expect(isTerminalAgentNodeState("completed")).toBe(true);

    expect(transitionAgentNode("cancelling", "cancelled")).toBe("cancelled");
    expect(() => transitionAgentNode("cancelled", "running")).toThrow(DomainTransitionError);
  });

  it("rejects self-transitions so duplicate delivery is handled by idempotency", () => {
    expect(() => transitionSession("idle", "idle")).toThrow(DomainTransitionError);
    expect(() => transitionTurn("running", "running")).toThrow(DomainTransitionError);
    expect(() => transitionApproval("pending", "pending")).toThrow(DomainTransitionError);
  });
});
