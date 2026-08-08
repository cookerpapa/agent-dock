import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
            {
              kind: "tool",
              toolCallId: "call-2",
              toolName: "read",
              input: { path: "/workspace/package.json" },
              output: { content: '{"name":"agent-dock"}' },
              status: "completed",
              firstSequence: 14,
              startedAt: "2026-07-29T10:00:01.000Z",
              completedAt: "2026-07-29T10:00:01.100Z",
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
        notice: string;
        turns: Array<{ visibleItems: Array<{ kind: string; status?: string }> }>;
      };
      expect(content.notice).toContain("previous turn ended unexpectedly");
      expect(content.turns[0]?.visibleItems).toContainEqual(
        expect.objectContaining({ kind: "tool", status: "unknown" }),
      );
      expect(entry.content).not.toContain("raw thinking");
      expect(entry.content).not.toContain(TURN_ID);
      expect(entry.content).not.toContain("assignment_lost");
      expect(entry.content).not.toContain("checkpointThroughSequence");
      expect(entry.content).not.toContain("proactively establish");
      expect(entry.content).not.toContain("Do not blindly repeat");
      const modelContext = JSON.stringify(manager.buildSessionContext().messages);
      expect(modelContext).toContain("user-visible events");
      expect(modelContext).toContain("Continue the interrupted refactor.");
      expect(modelContext).toContain("I started the refactor.");
      expect(modelContext).toContain("npm test");
      expect(modelContext).toContain("unknown");
      expect(modelContext).toContain("/workspace/package.json");
      expect(modelContext).toContain("agent-dock");
      expect(modelContext.match(/I started the refactor\./g)).toHaveLength(1);
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

  it("keeps the exact committed public suffix through Pi compaction and a fresh Worker", async () => {
    const workerA = await mkdtemp(resolve(tmpdir(), "agent-dock-recovery-worker-a-"));
    const workerB = await mkdtemp(resolve(tmpdir(), "agent-dock-recovery-worker-b-"));
    try {
      const source = SessionManager.create("/workspace", workerA);
      source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Old context replaced by compaction." }],
        timestamp: Date.now(),
      });
      appendPiDurableRecovery(source, recoverySuffix());
      const recoveryEntry = source.getEntries().at(-1);
      if (recoveryEntry?.type !== "custom_message") {
        throw new Error("Durable recovery entry was not recorded");
      }
      source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Continue after failover." }],
        timestamp: Date.now(),
      });
      source.appendCompaction("Earlier history was compacted.", recoveryEntry.id, 100_000, {
        source: "durable-visible-context-contract",
      });

      const header = source.getHeader();
      if (header === null) throw new Error("Pi Session header is missing");
      const restoredFile = resolve(workerB, "session.jsonl");
      await writeFile(
        restoredFile,
        `${[header, ...source.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      const restored = SessionManager.open(restoredFile, workerB, "/workspace");
      const context = JSON.stringify(convertToLlm(restored.buildSessionContext().messages));
      expect(context).not.toContain("Old context replaced by compaction.");
      expect(context).toContain("Earlier history was compacted.");
      expect(context).toContain("Continue the interrupted refactor.");
      expect(context).toContain("I started the refactor.");
      expect(context).toContain("npm test");
      expect(context).toContain("agent-dock");
      expect(context.match(/I started the refactor\./g)).toHaveLength(1);
    } finally {
      await rm(workerA, { recursive: true, force: true });
      await rm(workerB, { recursive: true, force: true });
    }
  });
});
