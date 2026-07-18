import { describe, expect, it } from "vitest";
import { TurnCommandOutboxProtocolError, parseTurnCommandOutboxPayload } from "../src/index.ts";

const payload = {
  schemaVersion: 1,
  commandId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  kind: "turn.execute",
} as const;

describe("turn-command outbox protocol", () => {
  it("parses the identity-only v1 payload", () => {
    expect(parseTurnCommandOutboxPayload(payload)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain("prompt");
  });

  it("rejects malformed identities, unknown kinds, and extra data", () => {
    expect(() => parseTurnCommandOutboxPayload({ ...payload, commandId: "command-1" })).toThrow(
      TurnCommandOutboxProtocolError,
    );
    expect(() => parseTurnCommandOutboxPayload({ ...payload, kind: "turn.cancel" })).toThrow(
      TurnCommandOutboxProtocolError,
    );
    expect(() =>
      parseTurnCommandOutboxPayload({ ...payload, prompt: "must stay in PostgreSQL" }),
    ).toThrow(TurnCommandOutboxProtocolError);
  });
});
