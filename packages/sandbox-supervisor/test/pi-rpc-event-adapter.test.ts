import { createAgentDockEventFactory } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { PiRpcAdapterError, PiRpcEventAdapter } from "../src/index.ts";

const EVENT_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const APPROVAL_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];

function createAdapter() {
  let eventIndex = 0;
  let approvalIndex = 0;
  const factory = createAgentDockEventFactory(
    { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
    {
      clock: () => new Date("2026-07-18T08:00:00.000Z"),
      idGenerator: () => EVENT_IDS[eventIndex++]!,
    },
  );
  return new PiRpcEventAdapter(factory, {
    approvalIdGenerator: () => APPROVAL_IDS[approvalIndex++]!,
  });
}

describe("PiRpcEventAdapter", () => {
  it("maps confirm and its decision without publishing the Pi request ID", () => {
    const adapter = createAdapter();
    const mapped = adapter.adaptOutput({
      type: "extension_ui_request",
      id: "private-pi-request-7",
      method: "confirm",
      title: "Allow?",
      message: "Continue?",
      timeout: 5_000,
    });

    expect(mapped.kind).toBe("mapped");
    if (mapped.kind !== "mapped" || mapped.event.type !== "approval.requested") {
      throw new Error("Expected an approval.requested event");
    }
    expect(mapped.event).toMatchObject({
      seq: 1,
      type: "approval.requested",
      payload: { approvalId: APPROVAL_IDS[0], kind: "confirm", timeoutMs: 5_000 },
    });
    expect(JSON.stringify(mapped.event)).not.toContain("private-pi-request-7");
    expect(adapter.pendingApprovalCount).toBe(1);

    const resolved = adapter.resolveApproval({ approvalId: APPROVAL_IDS[0]!, outcome: "approved" });
    expect(resolved.piResponse).toEqual({
      type: "extension_ui_response",
      id: "private-pi-request-7",
      confirmed: true,
    });
    expect(resolved.event).toMatchObject({
      seq: 2,
      type: "approval.resolved",
      payload: { approvalId: APPROVAL_IDS[0], outcome: "approved" },
    });
    expect(adapter.pendingApprovalCount).toBe(0);
  });

  it("maps notifications and defaults their level", () => {
    const adapter = createAdapter();
    const mapped = adapter.adaptOutput({
      type: "extension_ui_request",
      id: "pi-notify-1",
      method: "notify",
      message: "done",
    });

    expect(mapped).toMatchObject({
      kind: "mapped",
      event: { type: "ui.notification", payload: { message: "done", level: "info" } },
    });
  });

  it("validates select decisions against the offered options", () => {
    const adapter = createAdapter();
    const mapped = adapter.adaptOutput({
      type: "extension_ui_request",
      id: "pi-select-1",
      method: "select",
      title: "Pick",
      options: ["one", "two"],
    });
    if (mapped.kind !== "mapped") {
      throw new Error("Expected a mapped select approval");
    }
    const event = mapped.event;
    if (event.type !== "approval.requested" || event.payload.kind !== "select") {
      throw new Error("Expected a mapped select approval");
    }

    expect(() =>
      adapter.resolveApproval({
        approvalId: event.payload.approvalId,
        outcome: "approved",
        value: "three",
      }),
    ).toThrow("not one of the offered options");
    expect(adapter.pendingApprovalCount).toBe(1);

    const resolved = adapter.resolveApproval({
      approvalId: event.payload.approvalId,
      outcome: "approved",
      value: "two",
    });
    expect(resolved.piResponse).toEqual({
      type: "extension_ui_response",
      id: "pi-select-1",
      value: "two",
    });
    expect(resolved.event).toMatchObject({ seq: 2, type: "approval.resolved" });
    expect(adapter.pendingApprovalCount).toBe(0);
  });

  it("maps input requests and writes approved text back to Pi", () => {
    const adapter = createAdapter();
    const mapped = adapter.adaptOutput({
      type: "extension_ui_request",
      id: "private-pi-input-1",
      method: "input",
      title: "Branch name",
      placeholder: "feature/example",
      timeout: 3_000,
    });
    if (
      mapped.kind !== "mapped" ||
      mapped.event.type !== "approval.requested" ||
      mapped.event.payload.kind !== "input"
    ) {
      throw new Error("Expected a mapped input approval");
    }

    expect(mapped.event.payload).toMatchObject({
      kind: "input",
      placeholder: "feature/example",
      timeoutMs: 3_000,
    });
    expect(JSON.stringify(mapped.event)).not.toContain("private-pi-input-1");

    const resolved = adapter.resolveApproval({
      approvalId: mapped.event.payload.approvalId,
      outcome: "approved",
      value: "feature/cloud-runtime",
    });
    expect(resolved.piResponse).toEqual({
      type: "extension_ui_response",
      id: "private-pi-input-1",
      value: "feature/cloud-runtime",
    });
  });

  it("maps editor requests and translates cancellation", () => {
    const adapter = createAdapter();
    const mapped = adapter.adaptOutput({
      type: "extension_ui_request",
      id: "private-pi-editor-1",
      method: "editor",
      title: "Edit plan",
      prefill: "initial plan",
    });
    if (
      mapped.kind !== "mapped" ||
      mapped.event.type !== "approval.requested" ||
      mapped.event.payload.kind !== "editor"
    ) {
      throw new Error("Expected a mapped editor approval");
    }

    expect(mapped.event.payload).toMatchObject({ kind: "editor", initialValue: "initial plan" });
    expect(JSON.stringify(mapped.event)).not.toContain("private-pi-editor-1");

    const resolved = adapter.resolveApproval({
      approvalId: mapped.event.payload.approvalId,
      outcome: "cancelled",
    });
    expect(resolved.piResponse).toEqual({
      type: "extension_ui_response",
      id: "private-pi-editor-1",
      cancelled: true,
    });
  });

  it("does not publish malformed or unknown Pi output", () => {
    const adapter = createAdapter();
    expect(
      adapter.adaptOutput({ type: "extension_ui_request", id: "x", method: "confirm", title: "missing message" }),
    ).toMatchObject({ kind: "invalid", sourceType: "extension_ui_request.confirm" });
    expect(adapter.adaptOutput({ type: "brand_new_pi_event", secretField: "must-not-pass" })).toEqual({
      kind: "unsupported",
      sourceType: "brand_new_pi_event",
      reason: "No reviewed AgentDock v1 mapping exists for this Pi output type",
    });
  });

  it("rejects duplicate approval resolution", () => {
    const adapter = createAdapter();
    const mapped = adapter.adaptOutput({
      type: "extension_ui_request",
      id: "pi-confirm-1",
      method: "confirm",
      title: "Allow?",
      message: "Continue?",
    });
    if (mapped.kind !== "mapped" || mapped.event.type !== "approval.requested") {
      throw new Error("Expected a mapped confirm approval");
    }
    const approvalId = mapped.event.payload.approvalId;
    adapter.resolveApproval({ approvalId, outcome: "rejected" });
    expect(() => adapter.resolveApproval({ approvalId, outcome: "rejected" })).toThrow(PiRpcAdapterError);
  });
});
