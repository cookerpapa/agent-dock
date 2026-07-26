import {
  createCubeWorkspaceCheckpoint,
  createKopiaWorkspaceCheckpoint,
} from "@agent-dock/workspace-runtime";
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

  it("defers Kopia-backed Workspace bytes until the Tool Sandbox restores them", () => {
    const checkpoint = createKopiaWorkspaceCheckpoint({
      snapshotId: "0123456789abcdef0123456789abcdef",
      volumeId: `adw-${"a".repeat(48)}`,
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-project-instructions-test",
      workspaceId: "workspace-project-instructions-test",
      sessionId: "session-project-instructions-test",
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
      recipeCommands: [],
    });

    expect(projectInstructionsFromSnapshot(checkpoint)).toBeUndefined();
  });
});
