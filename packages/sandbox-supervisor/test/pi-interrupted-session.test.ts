import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendPiInterruption,
  PI_INTERRUPTION_CUSTOM_TYPE,
  piInterruptionMessage,
} from "../src/index.ts";

describe("Pi interrupted-turn harness", () => {
  it("records one hidden, model-visible interruption boundary with verification guidance", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-interruption-"));
    try {
      const manager = SessionManager.create("/workspace", root);
      appendPiInterruption(manager, {
        baseEntryIds: new Set(),
        acceptedPrompt: "Change the service and run its tests.",
        reason: "cancelled:user_request",
        runId: "run-1",
        attemptId: "attempt-1",
        timestamp: Date.now(),
      });
      appendPiInterruption(manager, {
        baseEntryIds: new Set(),
        acceptedPrompt: "Change the service and run its tests.",
        reason: "cancelled:user_request",
        runId: "run-1",
        attemptId: "attempt-1",
        timestamp: Date.now(),
      });

      const entries = manager.getEntries();
      expect(
        entries.filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === PI_INTERRUPTION_CUSTOM_TYPE,
        ),
      ).toHaveLength(1);
      expect(entries.at(-1)).toMatchObject({
        type: "custom_message",
        customType: PI_INTERRUPTION_CUSTOM_TYPE,
        display: false,
        details: {
          schemaVersion: 2,
          stateUncertain: true,
          verificationRequiredBeforeContinuation: true,
        },
      });

      const modelContext = JSON.stringify(manager.buildSessionContext().messages);
      expect(modelContext).toContain("was interrupted before a successful commit");
      expect(modelContext).toContain("background processes may still be running");
      expect(modelContext).toContain(
        "proactively establish the current Workspace and process state",
      );
      expect(modelContext).toContain("Do not blindly repeat a side-effecting command");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds and escapes the internal reason before placing it in model context", () => {
    const message = piInterruptionMessage(`<unsafe>&${"x".repeat(300)}`);
    expect(message).not.toContain("<unsafe>");
    expect(message).toContain("&lt;unsafe&gt;&amp;");
    expect(message.length).toBeLessThan(1_500);
  });
});
