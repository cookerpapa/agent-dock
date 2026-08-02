import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendPiInterruption,
  PI_INTERRUPTION_CUSTOM_TYPE,
  PI_SANDBOX_RESET_CUSTOM_TYPE,
  preparePiSandboxContinuity,
  recordPiSandboxActive,
} from "../src/index.ts";

const FIRST_ACTIVATION = "10000000-0000-4000-8000-000000000001";
const SECOND_ACTIVATION = "20000000-0000-4000-8000-000000000002";

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("Pi cloud recovery contract", () => {
  it("preserves one interruption and sandbox-reset boundary through compaction and a fresh Worker", async () => {
    const workerA = await mkdtemp(resolve(tmpdir(), "agent-dock-worker-a-"));
    const workerB = await mkdtemp(resolve(tmpdir(), "agent-dock-worker-b-"));
    try {
      const source = SessionManager.create("/workspace", workerA);
      source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Old history that compaction must replace." }],
        timestamp: Date.now(),
      });
      const baseEntryIds = new Set(source.getEntries().map((entry) => entry.id));
      appendPiInterruption(source, {
        baseEntryIds,
        acceptedPrompt: "Run the migration and verify it.",
        reason: "worker_lost:heartbeat_expired",
        runId: "internal-run-id",
        attemptId: "internal-attempt-id",
        timestamp: Date.now(),
      });
      recordPiSandboxActive(source, FIRST_ACTIVATION);
      preparePiSandboxContinuity(source, {
        activationId: SECOND_ACTIVATION,
        continuity: "cold_restore",
      });
      source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Continue on the replacement Worker." }],
        timestamp: Date.now(),
      });

      const interruption = source
        .getEntries()
        .find(
          (entry) =>
            entry.type === "custom_message" && entry.customType === PI_INTERRUPTION_CUSTOM_TYPE,
        );
      if (interruption === undefined) throw new Error("Interruption marker was not recorded");
      source.appendCompaction(
        "Earlier conversation was compacted before the Worker handoff.",
        interruption.id,
        32_000,
        { source: "cloud-recovery-contract" },
      );

      const header = source.getHeader();
      if (header === null) throw new Error("Source Pi Session header was not available");
      const restoredFile = resolve(workerB, "restored-session.jsonl");
      await writeFile(
        restoredFile,
        `${[header, ...source.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      const restored = SessionManager.open(restoredFile, workerB, "/workspace");

      const context = JSON.stringify(convertToLlm(restored.buildSessionContext().messages));
      expect(context).not.toContain("Old history that compaction must replace.");
      expect(context).toContain("Earlier conversation was compacted");
      expect(occurrences(context, "<turn_aborted>")).toBe(1);
      expect(occurrences(context, "<sandbox_reset>")).toBe(1);
      expect(context).not.toContain("worker_lost:heartbeat_expired");
      expect(context).not.toContain("internal-run-id");
      expect(context).not.toContain("internal-attempt-id");
      expect(context).not.toContain(FIRST_ACTIVATION);
      expect(context).not.toContain(SECOND_ACTIVATION);

      preparePiSandboxContinuity(restored, {
        activationId: SECOND_ACTIVATION,
        continuity: "cold_restore",
      });
      recordPiSandboxActive(restored, SECOND_ACTIVATION);
      preparePiSandboxContinuity(restored, {
        activationId: SECOND_ACTIVATION,
        continuity: "warm_reuse",
      });
      const repeatedContext = JSON.stringify(convertToLlm(restored.buildSessionContext().messages));
      expect(occurrences(repeatedContext, "<turn_aborted>")).toBe(1);
      expect(occurrences(repeatedContext, "<sandbox_reset>")).toBe(1);
      expect(
        restored
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
          ),
      ).toHaveLength(1);
    } finally {
      await rm(workerA, { recursive: true, force: true });
      await rm(workerB, { recursive: true, force: true });
    }
  });
});
