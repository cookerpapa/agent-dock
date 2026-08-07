import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE,
  PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE,
  PI_SANDBOX_RESET_CUSTOM_TYPE,
  PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE,
  PiStepWorldStateController,
} from "../src/index.ts";

const FIRST_ACTIVATION = "10000000-0000-4000-8000-000000000001";
const SECOND_ACTIVATION = "20000000-0000-4000-8000-000000000002";
const THIRD_ACTIVATION = "30000000-0000-4000-8000-000000000003";
const ENVIRONMENT_SHA256 = "a".repeat(64);
const TOOL_POLICY_SHA256 = "b".repeat(64);

function continuity(
  activationId: string,
  kind: "cold_restore" | "warm_reuse",
  environmentSha256 = ENVIRONMENT_SHA256,
  toolPolicySha256 = TOOL_POLICY_SHA256,
) {
  return {
    activationId,
    continuity: kind,
    environmentSha256,
    committedWorkspaceRevision: null,
    toolPolicySha256,
  } as const;
}

function messages(manager: SessionManager, customType: string) {
  return manager
    .getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === customType);
}

describe("Pi per-Step runtime world-state harness", () => {
  it("emits one minimal reset marker per lost active sandbox", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-sandbox-continuity-"));
    try {
      const manager = SessionManager.create("/workspace", root);

      new PiStepWorldStateController(
        manager,
        continuity(FIRST_ACTIVATION, "cold_restore"),
      ).capture();
      expect(messages(manager, PI_SANDBOX_RESET_CUSTOM_TYPE)).toHaveLength(0);

      const active = new PiStepWorldStateController(
        manager,
        continuity(FIRST_ACTIVATION, "cold_restore"),
      );
      active.recordActive();
      expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(
        FIRST_ACTIVATION,
      );

      new PiStepWorldStateController(manager, continuity(FIRST_ACTIVATION, "warm_reuse")).capture();
      expect(messages(manager, PI_SANDBOX_RESET_CUSTOM_TYPE)).toHaveLength(0);

      new PiStepWorldStateController(
        manager,
        continuity(SECOND_ACTIVATION, "cold_restore"),
      ).capture();
      new PiStepWorldStateController(
        manager,
        continuity(THIRD_ACTIVATION, "cold_restore"),
      ).capture();

      expect(messages(manager, PI_SANDBOX_RESET_CUSTOM_TYPE)).toHaveLength(1);
      expect(
        manager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE,
          ).length,
      ).toBeGreaterThanOrEqual(3);

      const context = JSON.stringify(manager.buildSessionContext().messages);
      expect(context).toContain("<sandbox_reset>");
      expect(context).toContain("running processes and in-memory environment state");
      expect(context).not.toContain(FIRST_ACTIVATION);
      expect(context).not.toContain(SECOND_ACTIVATION);
      expect(context).not.toContain(THIRD_ACTIVATION);
      expect(context).not.toContain("verify");
      expect(context).not.toContain("inspect");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits a later reset only after a fresh sandbox became active", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-sandbox-generation-"));
    try {
      const manager = SessionManager.create("/workspace", root);
      const first = new PiStepWorldStateController(
        manager,
        continuity(FIRST_ACTIVATION, "cold_restore"),
      );
      first.recordActive();
      new PiStepWorldStateController(
        manager,
        continuity(SECOND_ACTIVATION, "cold_restore"),
      ).capture();
      const second = new PiStepWorldStateController(
        manager,
        continuity(SECOND_ACTIVATION, "cold_restore"),
      );
      second.recordActive();
      new PiStepWorldStateController(
        manager,
        continuity(THIRD_ACTIVATION, "cold_restore"),
      ).capture();

      expect(messages(manager, PI_SANDBOX_RESET_CUSTOM_TYPE)).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects environment and Tool-policy changes without exposing hashes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-world-diff-"));
    try {
      const manager = SessionManager.create("/workspace", root);
      new PiStepWorldStateController(
        manager,
        continuity(FIRST_ACTIVATION, "cold_restore"),
      ).capture();
      const changed = new PiStepWorldStateController(
        manager,
        continuity(FIRST_ACTIVATION, "cold_restore", "c".repeat(64), "d".repeat(64)),
      ).capture();

      expect(messages(manager, PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE)).toHaveLength(1);
      expect(messages(manager, PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE)).toHaveLength(1);
      expect(changed.modelMessages).toHaveLength(2);
      const context = JSON.stringify(manager.buildSessionContext().messages);
      expect(context).toContain("<environment_changed>");
      expect(context).toContain("<tool_policy_changed>");
      expect(context).not.toContain("c".repeat(64));
      expect(context).not.toContain("d".repeat(64));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
