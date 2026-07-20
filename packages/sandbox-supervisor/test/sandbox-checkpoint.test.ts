import {
  decodeSettledCheckpoint,
  encodeSettledCheckpoint,
  validateLoadedCheckpoint,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

function piSession(cwd = "/workspace"): Uint8Array {
  return Buffer.from(
    [
      JSON.stringify({ type: "session", version: 3, id: "pi-session-test", cwd }),
      JSON.stringify({
        type: "message",
        id: "assistant-entry",
        parentId: null,
        timestamp: "2026-07-19T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "settled" }] },
      }),
      "",
    ].join("\n"),
  );
}

const emptyWorkspace = Buffer.from('{"format":"agent-dock.workspace-manifest.v1","files":[]}\n');

describe("settled sandbox checkpoint envelope", () => {
  it("round-trips bounded content and verifies the Pi workspace owner", () => {
    const encoded = encodeSettledCheckpoint({
      piSession: piSession(),
      workspace: emptyWorkspace,
      workspacePatch: {
        format: "unified_diff",
        patch: "diff --git a/Main.java b/Main.java\n",
        truncated: false,
      },
    });
    expect(decodeSettledCheckpoint(encoded)).toEqual({
      piSession: piSession(),
      workspace: emptyWorkspace,
      workspacePatch: {
        format: "unified_diff",
        patch: "diff --git a/Main.java b/Main.java\n",
        truncated: false,
      },
    });
    expect(
      validateLoadedCheckpoint({
        revision: "revision-1",
        ...decodeSettledCheckpoint(encoded),
      }),
    ).toMatchObject({ revision: "revision-1" });
  });

  it("rejects hash changes and a session captured from another cwd", () => {
    const encoded = encodeSettledCheckpoint({
      piSession: piSession(),
      workspace: emptyWorkspace,
    });
    expect(() =>
      decodeSettledCheckpoint({
        ...encoded,
        piSession: { ...encoded.piSession, sha256: "0".repeat(64) },
      }),
    ).toThrow(/hash/i);
    expect(() =>
      encodeSettledCheckpoint({
        piSession: piSession("/host/project"),
        workspace: emptyWorkspace,
      }),
    ).toThrow(/sandbox workspace/i);
  });
});
