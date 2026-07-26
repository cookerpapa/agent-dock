import { createCubeWorkspaceCheckpoint } from "@agent-dock/workspace-runtime";
import { describe, expect, it } from "vitest";
import { projectInstructionsFromSnapshot } from "../src/remote-tool-sandbox-turn-runner.ts";

describe("trusted project instruction extraction", () => {
  it("defers provider-native Workspace bytes until the Tool Sandbox restores them", () => {
    const checkpoint = createCubeWorkspaceCheckpoint({
      snapshotId: "snap-project-instructions-test",
      sourceSandboxId: "sandbox-project-instructions-test",
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-project-instructions-test",
      workspaceId: "workspace-project-instructions-test",
      bindingSha256: "a".repeat(64),
      fencingToken: 1,
      imageRevision: "test",
      environmentSpecSha256: "b".repeat(64),
      files: [
        {
          path: "AGENTS.md",
          executable: false,
          sizeBytes: 128,
          sha256: "c".repeat(64),
        },
      ],
      authority: {
        keyVersion: 1,
        nonce: "a".repeat(16),
        ciphertext: "b".repeat(64),
        authTag: "c".repeat(22),
      },
    });

    expect(projectInstructionsFromSnapshot(checkpoint)).toBeUndefined();
  });
});
