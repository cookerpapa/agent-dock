import {
  decodeWorkspaceSnapshot,
  encodeWorkspaceSnapshot,
  validateLoadedCheckpoint,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

const emptyWorkspace = Buffer.from('{"format":"agent-dock.workspace-manifest.v1","files":[]}\n');

describe("sandbox checkpoint values", () => {
  it("round-trips a bounded Workspace snapshot", () => {
    const encoded = encodeWorkspaceSnapshot(emptyWorkspace);
    expect(decodeWorkspaceSnapshot(encoded)).toEqual(emptyWorkspace);
    expect(
      validateLoadedCheckpoint({
        revision: "revision-1",
        workspace: decodeWorkspaceSnapshot(encoded),
      }),
    ).toMatchObject({ revision: "revision-1", workspace: emptyWorkspace });
  });

  it("rejects a changed Workspace hash", () => {
    const encoded = encodeWorkspaceSnapshot(emptyWorkspace);
    expect(() =>
      decodeWorkspaceSnapshot({
        ...encoded,
        sha256: "0".repeat(64),
      }),
    ).toThrow(/hash/i);
  });
});
