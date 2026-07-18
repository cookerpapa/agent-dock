import { describe, expect, it } from "vitest";
import {
  ControlPlaneApiValidationError,
  parseAcceptTurnRequest,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseIdempotencyKey,
  parseLastEventIdHeader,
  parseUuidPathParameter,
} from "../src/index.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("control-plane public API schemas", () => {
  it("normalizes project names and preserves prompt text", () => {
    expect(parseCreateProjectRequest({ name: "  AgentDock  " })).toEqual({ name: "AgentDock" });
    expect(parseAcceptTurnRequest({ prompt: "  fix the test  ", thinkingLevel: "low" })).toEqual({
      prompt: "  fix the test  ",
      thinkingLevel: "low",
    });
  });

  it("validates workspace and path identities as UUIDs", () => {
    expect(parseCreateSessionRequest({ workspaceId: UUID })).toEqual({ workspaceId: UUID });
    expect(parseUuidPathParameter(UUID, "sessionId")).toBe(UUID);
    expect(() => parseUuidPathParameter("session-1", "sessionId")).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("rejects whitespace-only values, extra fields, and unsupported thinking levels", () => {
    expect(() => parseCreateProjectRequest({ name: "   " })).toThrow(
      "Project name must contain a non-whitespace character",
    );
    expect(() => parseAcceptTurnRequest({ prompt: "\n\t" })).toThrow(
      "Turn prompt must contain a non-whitespace character",
    );
    expect(() => parseAcceptTurnRequest({ prompt: "hello", rawProvider: "secret" })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() => parseAcceptTurnRequest({ prompt: "hello", thinkingLevel: "turbo" })).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("accepts portable idempotency keys and rejects ambiguous header values", () => {
    expect(parseIdempotencyKey("request-01:retry.2")).toBe("request-01:retry.2");
    expect(() => parseIdempotencyKey(undefined)).toThrow(ControlPlaneApiValidationError);
    expect(() => parseIdempotencyKey(["one", "two"])).toThrow(ControlPlaneApiValidationError);
    expect(() => parseIdempotencyKey("contains whitespace")).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("parses canonical resumable SSE cursors", () => {
    expect(parseLastEventIdHeader(undefined)).toBe(0);
    expect(parseLastEventIdHeader("0")).toBe(0);
    expect(parseLastEventIdHeader("42")).toBe(42);
    for (const invalid of ["", "01", "-1", "+1", " 1", ["1", "2"], 1]) {
      expect(() => parseLastEventIdHeader(invalid)).toThrow(ControlPlaneApiValidationError);
    }
    expect(() => parseLastEventIdHeader(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(
      "outside the supported integer range",
    );
  });
});
