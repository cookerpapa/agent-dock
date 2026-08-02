import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
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
  it("records one hidden, model-visible Codex-style interruption boundary", async () => {
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
          runId: "run-1",
          attemptId: "attempt-1",
          reason: "cancelled:user_request",
        },
      });

      const modelContext = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
      expect(modelContext).toContain("<turn_aborted>");
      expect(modelContext).toContain("The previous turn was interrupted");
      expect(modelContext).toContain("background processes may still be running");
      expect(modelContext).not.toContain("cancelled:user_request");
      expect(modelContext).not.toContain("run-1");
      expect(modelContext).not.toContain("proactively establish");
      expect(modelContext).not.toContain("Do not blindly repeat");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not place internal reason codes in the model message", () => {
    const message = piInterruptionMessage();
    expect(message).toBe(
      [
        "<turn_aborted>",
        "The previous turn was interrupted. Any commands that were stopped may have partially executed, and background processes may still be running.",
        "</turn_aborted>",
      ].join("\n"),
    );
    expect(message).not.toContain("reason");
  });
});
