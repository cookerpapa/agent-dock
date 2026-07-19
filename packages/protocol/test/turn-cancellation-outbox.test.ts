import { describe, expect, it } from "vitest";
import {
  TurnCancellationOutboxProtocolError,
  parseTurnCancellationOutboxPayload,
} from "../src/index.ts";

const payload = {
  schemaVersion: 1,
  commandId: "11111111-1111-4111-8111-111111111111",
  targetCommandId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  kind: "turn.cancel",
} as const;

describe("turn-cancellation outbox protocol", () => {
  it("parses an identity-only cancellation payload", () => {
    expect(parseTurnCancellationOutboxPayload(payload)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain("prompt");
  });

  it("rejects a missing target, the execute kind, and extra data", () => {
    const { targetCommandId: _targetCommandId, ...withoutTarget } = payload;
    expect(() => parseTurnCancellationOutboxPayload(withoutTarget)).toThrow(
      TurnCancellationOutboxProtocolError,
    );
    expect(() => parseTurnCancellationOutboxPayload({ ...payload, kind: "turn.execute" })).toThrow(
      TurnCancellationOutboxProtocolError,
    );
    expect(() =>
      parseTurnCancellationOutboxPayload({ ...payload, reason: "user_request" }),
    ).toThrow(TurnCancellationOutboxProtocolError);
  });
});
