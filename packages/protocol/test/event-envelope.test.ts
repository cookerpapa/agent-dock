import { describe, expect, it } from "vitest";
import {
  PiCloudProtocolError,
  createPiCloudEventFactory,
  modelSamplingHeaders,
  parsePiCloudEvent,
  parseModelSamplingIdentity,
  type PiCloudEventBody,
} from "../src/index.ts";

const EVENT_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function createFactory(initialSequence = 0) {
  let idIndex = 0;
  return createPiCloudEventFactory(
    { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
    {
      initialSequence,
      clock: () => new Date("2026-07-18T08:00:00.000Z"),
      idGenerator: () => EVENT_IDS[idIndex++]!,
    },
  );
}

describe("PiCloudEventSchema", () => {
  it("creates validated, monotonically sequenced events", () => {
    const factory = createFactory(40);
    const first = factory.next({ type: "turn.started", payload: { inputKind: "prompt" } });
    const second = factory.next({ type: "assistant.text.delta", payload: { text: "hello" } });

    expect(first).toMatchObject({ schemaVersion: 1, seq: 41, turnId: "turn-1" });
    expect(second).toMatchObject({ seq: 42, type: "assistant.text.delta" });
    expect(factory.currentSequence()).toBe(42);
    expect(parsePiCloudEvent(second)).toEqual(second);
  });

  it("covers the public v1 event categories", () => {
    const bodies: PiCloudEventBody[] = [
      { type: "turn.started", payload: { inputKind: "continue" } },
      { type: "session.state.changed", payload: { from: "idle", to: "running" } },
      {
        type: "model.sampling.started",
        payload: { stepSequence: 1, stepSha256: "a".repeat(64), samplingAttempt: 1 },
      },
      {
        type: "model.sampling.completed",
        payload: {
          stepSequence: 1,
          stepSha256: "a".repeat(64),
          samplingAttempt: 1,
          outcome: "completed",
          stopReason: "toolUse",
        },
      },
      {
        type: "model.sampling.retry.scheduled",
        payload: {
          stepSequence: 1,
          stepSha256: "a".repeat(64),
          completedSamplingAttempt: 1,
          nextSamplingAttempt: 2,
          maximumSamplingAttempts: 3,
          delayMs: 100,
        },
      },
      { type: "assistant.text.delta", payload: { text: "partial" } },
      {
        type: "tool.started",
        payload: { toolCallId: "call-1", toolName: "read", input: { path: "a" } },
      },
      {
        type: "tool.completed",
        payload: { toolCallId: "call-1", outcome: "completed", output: "ok" },
      },
      {
        type: "approval.requested",
        payload: {
          approvalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "confirm",
          title: "Allow?",
          message: "Continue?",
        },
      },
      {
        type: "approval.resolved",
        payload: { approvalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", outcome: "approved" },
      },
      { type: "ui.notification", payload: { message: "done", level: "info" } },
      { type: "turn.completed", payload: { stopReason: "agent_end" } },
      {
        type: "turn.failed",
        payload: { code: "model_timeout", message: "timed out", retryable: true },
      },
      { type: "turn.cancelled", payload: { reason: "user_request", forced: false } },
    ];

    let id = 0;
    const factory = createPiCloudEventFactory(
      { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
      {
        clock: () => new Date("2026-07-18T08:00:00.000Z"),
        idGenerator: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-000000000000`,
      },
    );

    expect(bodies.map((body) => factory.next(body).type)).toEqual(bodies.map((body) => body.type));
  });

  it("rejects missing identity, invalid sequence, and extra raw fields", () => {
    const valid = createFactory().next({
      type: "ui.notification",
      payload: { message: "ok", level: "info" },
    });

    expect(() => parsePiCloudEvent({ ...valid, sessionId: "" })).toThrow(PiCloudProtocolError);
    expect(() => parsePiCloudEvent({ ...valid, seq: 0 })).toThrow(PiCloudProtocolError);
    expect(() =>
      parsePiCloudEvent({ ...valid, piRawEvent: { type: "extension_ui_request" } }),
    ).toThrow(PiCloudProtocolError);
  });

  it("accepts a bounded final workspace patch on turn completion", () => {
    const completion = createFactory().next({
      type: "turn.completed",
      payload: {
        stopReason: "stop",
        workspacePatch: {
          format: "unified_diff",
          patch: "diff --git a/src/App.java b/src/App.java\n",
          truncated: false,
        },
      },
    });
    expect(parsePiCloudEvent(completion)).toEqual(completion);

    expect(() =>
      createFactory().next({
        type: "turn.completed",
        payload: {
          stopReason: "stop",
          workspacePatch: {
            format: "unified_diff",
            patch: "x".repeat(65_537),
            truncated: true,
          },
        },
      }),
    ).toThrow(PiCloudProtocolError);

    expect(() =>
      createFactory().next({
        type: "turn.completed",
        payload: {
          stopReason: "stop",
          workspacePatch: {
            format: "unified_diff",
            patch: "界".repeat(21_846),
            truncated: true,
          },
        },
      }),
    ).toThrow("UTF-8 content exceeds 65536 bytes");
  });

  it("rejects an invalid initial sequence", () => {
    expect(() => createFactory(-1)).toThrow("initialSequence must be a non-negative safe integer");
  });

  it("round-trips bounded model sampling headers", () => {
    const identity = {
      stepSequence: 7,
      stepSha256: "f".repeat(64),
      samplingAttempt: 2,
    } as const;
    const headers = modelSamplingHeaders(identity);
    expect(
      parseModelSamplingIdentity({
        stepSequence: headers["x-pi-cloud-step-sequence"],
        stepSha256: headers["x-pi-cloud-step-sha256"],
        samplingAttempt: headers["x-pi-cloud-sampling-attempt"],
      }),
    ).toEqual(identity);
    expect(() =>
      parseModelSamplingIdentity({
        stepSequence: "0",
        stepSha256: "f".repeat(64),
        samplingAttempt: "1",
      }),
    ).toThrow("positive safe integer");
  });

  it("allows null turn IDs only for session-level events", () => {
    let idIndex = 0;
    const factory = createPiCloudEventFactory(
      { sessionId: "session-1", turnId: null, agentId: "root" },
      {
        clock: () => new Date("2026-07-18T08:00:00.000Z"),
        idGenerator: () => EVENT_IDS[idIndex++]!,
      },
    );

    const stateEvent = factory.next({
      type: "session.state.changed",
      payload: { from: "cold", to: "starting" },
    });
    expect(stateEvent).toMatchObject({ seq: 1, turnId: null });

    expect(() => factory.next({ type: "turn.started", payload: { inputKind: "prompt" } })).toThrow(
      PiCloudProtocolError,
    );
    expect(factory.currentSequence()).toBe(1);
  });

  it("does not consume a sequence number when event validation fails", () => {
    const factory = createFactory();
    const invalidBody = {
      type: "ui.notification",
      payload: { message: "bad level", level: "debug" },
    } as unknown as PiCloudEventBody;

    expect(() => factory.next(invalidBody)).toThrow(PiCloudProtocolError);
    expect(factory.currentSequence()).toBe(0);

    const valid = factory.next({
      type: "ui.notification",
      payload: { message: "ok", level: "info" },
    });
    expect(valid.seq).toBe(1);
  });
});
