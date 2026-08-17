import { createPersistentVolumeReference } from "@pi-cloud/workspace-runtime";
import { describe, expect, it } from "vitest";
import { projectInstructionsFromSnapshot } from "../src/remote-tool-sandbox-turn-runner.ts";

describe("trusted project instruction extraction", () => {
  it("defers persistent Volume bytes until the Tool Sandbox attaches them", () => {
    const checkpoint = createPersistentVolumeReference({
      volumeId: `pcw-${"a".repeat(48)}`,
      volumeRevision: "e".repeat(64),
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-project-instructions-test",
      workspaceId: "workspace-project-instructions-test",
      sourceSessionId: "session-project-instructions-test",
      bindingSha256: "a".repeat(64),
      fencingToken: 1,
      imageRevision: "test",
      environmentSpecSha256: "b".repeat(64),
      gitBaselineCommit: "d".repeat(40),
      files: [
        {
          path: "AGENTS.md",
          executable: false,
          sizeBytes: 128,
          sha256: "c".repeat(64),
        },
      ],
      recipeCommands: [],
    });

    expect(projectInstructionsFromSnapshot(checkpoint)).toBeUndefined();
  });
});
