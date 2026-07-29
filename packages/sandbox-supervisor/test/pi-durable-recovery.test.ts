import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendPiDurableRecovery,
  PI_DURABLE_RECOVERY_CUSTOM_TYPE,
  type PiDurableRecoverySuffix,
} from "../src/index.ts";

const TURN_ID = "10000000-0000-4000-8000-000000000001";

function recoverySuffix(): PiDurableRecoverySuffix {
  return {
    checkpointThroughSequence: 10,
    recoveredThroughSequence: 14,
    turns: [
      {
        turnId: TURN_ID,
        input: "Continue the interrupted refactor.",
        transcript: {
          schemaVersion: 1,
          throughSequence: 14,
          startedSequence: 11,
          terminalSequence: 14,
          stopReason: null,
          failure: {
            code: "assignment_lost",
            message: "The previous Worker disappeared",
            retryable: true,
          },
          cancellation: null,
          workspacePatch: null,
          items: [
            {
              kind: "text",
              text: "I started the refactor.",
              firstSequence: 12,
              lastSequence: 12,
            },
            {
              kind: "tool",
              toolCallId: "call-1",
              toolName: "bash",
              input: { command: "npm test" },
              status: "running",
              firstSequence: 13,
              startedAt: "2026-07-29T10:00:00.000Z",
            },
          ],
        },
      },
    ],
  };
}

describe("Pi durable crash recovery", () => {
  it("injects only durable public semantics and marks in-flight tools unknown", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-recovery-"));
    try {
      const manager = SessionManager.create("/workspace", root);
      appendPiDurableRecovery(manager, recoverySuffix());

      const entry = manager.getEntries().at(-1);
      expect(entry).toMatchObject({
        type: "custom_message",
        customType: PI_DURABLE_RECOVERY_CUSTOM_TYPE,
        display: false,
      });
      if (entry?.type !== "custom_message" || typeof entry.content !== "string") {
        throw new Error("Expected a durable recovery custom message");
      }
      const content = JSON.parse(entry.content) as {
        turns: Array<{ visibleItems: Array<{ kind: string; status?: string }> }>;
      };
      expect(content.turns[0]?.visibleItems).toContainEqual(
        expect.objectContaining({ kind: "tool", status: "unknown" }),
      );
      expect(entry.content).not.toContain("raw thinking");
      expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(
        "durable public events",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a large recovery message bounded and valid JSON", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-pi-recovery-large-"));
    try {
      const suffix = recoverySuffix();
      const large = {
        ...suffix,
        turns: suffix.turns.map((turn) => ({
          ...turn,
          input: "p".repeat(600_000),
          transcript: {
            ...turn.transcript,
            items: Array.from({ length: 64 }, (_, index) => ({
              kind: "text" as const,
              text: `${String(index)}-${"x".repeat(20_000)}`,
              firstSequence: 12,
              lastSequence: 12,
            })),
          },
        })),
      };
      const manager = SessionManager.create("/workspace", root);
      appendPiDurableRecovery(manager, large);
      const entry = manager.getEntries().at(-1);
      if (entry?.type !== "custom_message" || typeof entry.content !== "string") {
        throw new Error("Expected a durable recovery custom message");
      }
      const content = entry.content;
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(512 * 1_024);
      expect(() => JSON.parse(content)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
