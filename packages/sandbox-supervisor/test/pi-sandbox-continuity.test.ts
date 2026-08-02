import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PI_SANDBOX_RESET_CUSTOM_TYPE,
  PI_SANDBOX_STATE_CUSTOM_TYPE,
  preparePiSandboxContinuity,
  recordPiSandboxActive,
} from "../src/index.ts";

const FIRST_ACTIVATION = "10000000-0000-4000-8000-000000000001";
const SECOND_ACTIVATION = "20000000-0000-4000-8000-000000000002";
const THIRD_ACTIVATION = "30000000-0000-4000-8000-000000000003";

describe("Pi sandbox continuity harness", () => {
  it("emits one minimal reset marker per lost active sandbox", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-sandbox-continuity-"));
    try {
      const manager = SessionManager.create("/workspace", root);

      preparePiSandboxContinuity(manager, {
        activationId: FIRST_ACTIVATION,
        continuity: "cold_restore",
      });
      expect(manager.getEntries()).toHaveLength(0);

      recordPiSandboxActive(manager, FIRST_ACTIVATION);
      expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(
        FIRST_ACTIVATION,
      );

      preparePiSandboxContinuity(manager, {
        activationId: FIRST_ACTIVATION,
        continuity: "warm_reuse",
      });
      expect(
        manager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
          ),
      ).toHaveLength(0);

      preparePiSandboxContinuity(manager, {
        activationId: SECOND_ACTIVATION,
        continuity: "cold_restore",
      });
      preparePiSandboxContinuity(manager, {
        activationId: THIRD_ACTIVATION,
        continuity: "cold_restore",
      });

      expect(
        manager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
          ),
      ).toHaveLength(1);
      expect(
        manager
          .getEntries()
          .filter(
            (entry) => entry.type === "custom" && entry.customType === PI_SANDBOX_STATE_CUSTOM_TYPE,
          ),
      ).toHaveLength(2);

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
      recordPiSandboxActive(manager, FIRST_ACTIVATION);
      preparePiSandboxContinuity(manager, {
        activationId: SECOND_ACTIVATION,
        continuity: "cold_restore",
      });
      recordPiSandboxActive(manager, SECOND_ACTIVATION);
      preparePiSandboxContinuity(manager, {
        activationId: THIRD_ACTIVATION,
        continuity: "cold_restore",
      });

      expect(
        manager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
          ),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
