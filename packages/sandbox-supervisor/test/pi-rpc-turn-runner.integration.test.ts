import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcTurnCancelledError, PiRpcTurnError, PiRpcTurnRunner } from "../src/index.ts";

const command: ExecuteTurnCommandMessage = {
  protocolVersion: 1,
  messageId: "11111111-1111-4111-8111-111111111111",
  sentAt: "2026-07-18T08:00:00.000Z",
  type: "command.turn.execute",
  payload: {
    commandId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "runner-integration",
    tenantId: "tenant-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    runId: "44444444-4444-4444-8444-444444444444",
    turnId: "turn-1",
    attemptId: "55555555-5555-4555-8555-555555555555",
    agentId: "root",
    leaseId: "33333333-3333-4333-8333-333333333333",
    fencingToken: 7,
    nextEventSeq: 5,
    input: { kind: "prompt", text: "Return the deterministic fake response." },
    model: {
      profileId: "profile-1",
      provider: "agent-dock-fake",
      modelId: "agent-dock-fake",
      thinkingLevel: "off",
      credentialBindingId: "credential-1",
      credentialBindingVersion: 1,
    },
    environment: {
      environmentVersionId: "66666666-6666-4666-8666-666666666666",
      versionNumber: 1,
      profileKey: "agent-dock-fullstack",
      profileVersion: "1",
      imageRevision: "development",
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
  },
};

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for integration condition");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
        const commandEnd = statLine.lastIndexOf(")");
        const state =
          commandEnd < 0
            ? undefined
            : statLine
                .slice(commandEnd + 1)
                .trim()
                .split(/\s+/)[0];
        if (state === "Z" || state === "X") return false;
      } catch {
        return false;
      }
    }
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

describe("PiRpcTurnRunner integration", () => {
  it("does not publish completion when settled checkpoint commit fails", async () => {
    const fakeModel = new FakeModelServer();
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-checkpoint-fail-test-"));
    const events: EventPublishMessage[] = [];
    try {
      await fakeModel.start();
      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
        }),
        onSettled: () => {
          throw new PiRpcTurnError(
            "checkpoint_save_failed",
            "Settled checkpoint could not be committed",
            true,
          );
        },
      });
      await expect(
        runner.run(command, (message) => {
          events.push(message);
        }),
      ).rejects.toMatchObject({ code: "checkpoint_save_failed", retryable: true });
      expect(events.some((message) => message.payload.event.type === "turn.completed")).toBe(false);
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("captures Pi JSONL before completion and rehydrates it in a fresh runner", async () => {
    const fakeModel = new FakeModelServer();
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-rehydrate-test-"));
    let checkpoint: Uint8Array | undefined;
    let checkpointCommitted = false;
    try {
      await fakeModel.start();
      const runnerOptions = {
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model: ExecuteTurnCommandMessage["payload"]["model"]) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions" as const,
          apiKey: FAKE_MODEL_API_KEY,
        }),
      };
      const first = new PiRpcTurnRunner({
        ...runnerOptions,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
          checkpointCommitted = true;
        },
      });
      await first.run(command, (message) => {
        if (message.payload.event.type === "turn.completed") {
          expect(checkpointCommitted).toBe(true);
        }
      });
      expect(checkpoint).toBeDefined();
      expect(Buffer.from(checkpoint!).toString("utf8")).toContain('"role":"assistant"');

      checkpointCommitted = false;
      const secondCommand: ExecuteTurnCommandMessage = {
        ...command,
        messageId: "11111111-1111-4111-8111-111111111112",
        payload: {
          ...command.payload,
          commandId: "22222222-2222-4222-8222-222222222223",
          idempotencyKey: "runner-integration-followup",
          turnId: "turn-2",
          fencingToken: 8,
          nextEventSeq: 9,
          input: { kind: "prompt", text: "Continue from the prior turn." },
        },
      };
      const second = new PiRpcTurnRunner({
        ...runnerOptions,
        restorePiSession: checkpoint!,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
          checkpointCommitted = true;
        },
      });
      await second.run(secondCommand, (message) => {
        if (message.payload.event.type === "turn.completed") {
          expect(checkpointCommitted).toBe(true);
        }
      });
      expect(fakeModel.observations).toHaveLength(2);
      expect(fakeModel.observations[1]!.messageCount).toBeGreaterThan(
        fakeModel.observations[0]!.messageCount,
      );
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists a native Pi compaction entry and restores it in a fresh worker process", async () => {
    const fakeModel = new FakeModelServer({ promptTokens: 3_500 });
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-compaction-test-"));
    let checkpoint: Uint8Array | undefined;
    const firstEvents: EventPublishMessage[] = [];
    try {
      await fakeModel.start();
      const compactingCommand: ExecuteTurnCommandMessage = {
        ...command,
        messageId: "11111111-1111-4111-8111-111111111121",
        payload: {
          ...command.payload,
          commandId: "22222222-2222-4222-8222-222222222231",
          idempotencyKey: "runner-native-compaction",
          turnId: "turn-compaction-1",
          input: { kind: "prompt", text: `first compactable turn ${"seed ".repeat(1_200)}` },
          budgets: {
            maximumModelRequests: 8,
            maximumCostMicrousd: 1_000_000,
            dailyTokenBudget: 1_000_000,
            monthlyCostMicrousdBudget: 1_000_000,
            maximumToolCalls: 8,
            remainingToolCalls: 8,
            maximumToolOutputBytes: 64 * 1_024,
            maximumRunDurationMs: 60_000,
            compactionReserveTokens: 1_024,
            compactionKeepRecentTokens: 1_024,
          },
        },
      };
      const runnerOptions = {
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model: ExecuteTurnCommandMessage["payload"]["model"]) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions" as const,
          apiKey: FAKE_MODEL_API_KEY,
          contextWindow: 4_096,
          maxTokens: 512,
        }),
      };
      await new PiRpcTurnRunner({
        ...runnerOptions,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
        },
      }).run(compactingCommand, (event) => {
        firstEvents.push(event);
      });

      const triggerCommand: ExecuteTurnCommandMessage = {
        ...compactingCommand,
        messageId: "11111111-1111-4111-8111-111111111122",
        payload: {
          ...compactingCommand.payload,
          commandId: "22222222-2222-4222-8222-222222222232",
          idempotencyKey: "runner-native-compaction-followup",
          turnId: "turn-compaction-2",
          fencingToken: 8,
          nextEventSeq: 20,
          input: {
            kind: "prompt",
            text: `second compactable turn ${"recent ".repeat(1_200)}`,
          },
        },
      };
      const compactionEvents: EventPublishMessage[] = [];
      await new PiRpcTurnRunner({
        ...runnerOptions,
        restorePiSession: checkpoint!,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
        },
      }).run(triggerCommand, (event) => {
        compactionEvents.push(event);
      });
      const checkpointText = Buffer.from(checkpoint!).toString("utf8");
      const compactionEntry = checkpointText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; id?: string })
        .find((entry) => entry.type === "compaction");
      expect(compactionEntry?.id).toBeTypeOf("string");
      expect(compactionEvents.map((event) => event.payload.event.type)).toEqual(
        expect.arrayContaining(["context.compaction.started", "context.compaction.completed"]),
      );
      expect(firstEvents.some((event) => event.payload.event.type === "turn.completed")).toBe(true);

      const restoredCommand: ExecuteTurnCommandMessage = {
        ...triggerCommand,
        messageId: "11111111-1111-4111-8111-111111111123",
        payload: {
          ...triggerCommand.payload,
          commandId: "22222222-2222-4222-8222-222222222233",
          idempotencyKey: "runner-native-compaction-restored",
          turnId: "turn-compaction-3",
          fencingToken: 9,
          nextEventSeq: 40,
          input: { kind: "prompt", text: "Prove the compacted session survived a new worker." },
        },
      };
      let restoredCheckpoint: Uint8Array | undefined;
      await new PiRpcTurnRunner({
        ...runnerOptions,
        restorePiSession: checkpoint!,
        onSettled: ({ piSession }) => {
          restoredCheckpoint = piSession;
        },
      }).run(restoredCommand, () => undefined);
      const restoredText = Buffer.from(restoredCheckpoint!).toString("utf8");
      expect(restoredText).toContain(`"id":"${compactionEntry!.id!}"`);
      expect(restoredText.length).toBeGreaterThan(checkpointText.length);
      expect(fakeModel.observations.length).toBeGreaterThanOrEqual(4);
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs pinned Pi against the loopback fake model and emits only public events", async () => {
    const fakeModel = new FakeModelServer();
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-test-"));
    const events: EventPublishMessage[] = [];
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--agent-dock-must-filter-this-option";
    try {
      await fakeModel.start();
      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
        }),
        collectWorkspacePatch: () => ({
          format: "unified_diff",
          patch: "diff --git a/src/App.java b/src/App.java\n",
          truncated: false,
        }),
      });

      await expect(
        runner.run(command, (message) => {
          events.push(message);
        }),
      ).resolves.toEqual({ stopReason: "stop" });
      expect(events.map((message) => message.payload.event.type)).toEqual([
        "turn.started",
        "assistant.text.delta",
        "assistant.text.delta",
        "turn.completed",
      ]);
      expect(events.map((message) => message.payload.event.seq)).toEqual([5, 6, 7, 8]);
      expect(events.at(-1)?.payload.event).toMatchObject({
        type: "turn.completed",
        payload: {
          workspacePatch: {
            format: "unified_diff",
            patch: "diff --git a/src/App.java b/src/App.java\n",
            truncated: false,
          },
        },
      });
      expect(JSON.stringify(events)).not.toContain(FAKE_MODEL_API_KEY);
      expect(JSON.stringify(events)).not.toContain("Return the deterministic fake response.");
      expect(await readdir(workspace)).toEqual([]);
      expect(fakeModel.observations).toHaveLength(1);
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists a full large tool result before publishing its bounded event reference", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-tool-output-test-"));
    const events: EventPublishMessage[] = [];
    const captured: Uint8Array[] = [];
    try {
      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
        }),
        piRpcEntryPath: resolve(import.meta.dirname, "fixtures/tool-output-rpc.mjs"),
        persistToolOutputArtifact: async ({ toolCallId, bytes }) => {
          expect(toolCallId).toBe("tool-call-large-output");
          captured.push(bytes);
          return {
            artifactId: "60000000-0000-4000-8000-000000000001",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.byteLength,
          };
        },
      });
      await runner.run(command, (message) => {
        events.push(message);
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual(Buffer.alloc(2_048, 0x61));
      expect(
        events.find((event) => event.payload.event.type === "tool.completed")?.payload.event,
      ).toMatchObject({
        type: "tool.completed",
        payload: {
          output: "bounded preview",
          outputArtifact: {
            artifactId: "60000000-0000-4000-8000-000000000001",
            sizeBytes: 2_048,
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("aborts a live Pi model request and publishes cancellation only after teardown", async () => {
    const fakeModel = new FakeModelServer({ defaultScenario: "timeout" });
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-cancel-test-"));
    const events: EventPublishMessage[] = [];
    const controller = new AbortController();
    let interruptedCheckpoint: Uint8Array | undefined;
    try {
      await fakeModel.start();
      const runner = new PiRpcTurnRunner({
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
        }),
        turnTimeoutMs: 20_000,
        onInterrupted: ({ piSession, reason }) => {
          expect(reason).toBe("cancelled:user_request");
          interruptedCheckpoint = piSession;
        },
      });

      const running = runner.run(
        command,
        (message) => {
          events.push(message);
        },
        controller.signal,
      );
      void running.catch(() => undefined);
      await waitFor(() => fakeModel.activeRequests === 1);
      controller.abort({
        kind: "agent-dock.turn-cancellation",
        reason: "user_request",
        gracePeriodMs: 2_000,
      });

      await expect(running).rejects.toMatchObject({
        name: "PiRpcTurnCancelledError",
        reason: "user_request",
        forced: false,
      } satisfies Partial<PiRpcTurnCancelledError>);
      expect(events.map((message) => message.payload.event.type)).toEqual([
        "turn.started",
        "turn.cancelled",
      ]);
      expect(events[1]?.payload.event).toMatchObject({
        type: "turn.cancelled",
        payload: { reason: "user_request", forced: false },
      });
      await waitFor(() => fakeModel.observations[0]?.completion === "client_aborted");
      const interruptedJsonl = Buffer.from(interruptedCheckpoint!).toString("utf8");
      expect(interruptedJsonl).toContain('"role":"user"');
      expect(interruptedJsonl).toContain('"customType":"agent-dock.run_interrupted"');
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(process.platform !== "win32")(
    "kills and confirms a descendant process when RPC abort is ignored",
    async () => {
      const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-force-cancel-test-"));
      const events: EventPublishMessage[] = [];
      const controller = new AbortController();
      let descendantPid: number | undefined;
      try {
        const runner = new PiRpcTurnRunner({
          resolveWorkspaceDirectory: () => workspace,
          resolveModelRuntime: (model) => ({
            provider: model.provider,
            modelId: model.modelId,
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: FAKE_MODEL_API_KEY,
          }),
          piRpcEntryPath: resolve(import.meta.dirname, "fixtures/ignore-abort-rpc.mjs"),
          turnTimeoutMs: 10_000,
          shutdownTimeoutMs: 500,
        });

        const running = runner.run(
          command,
          (message) => {
            events.push(message);
          },
          controller.signal,
        );
        void running.catch(() => undefined);
        await waitFor(async () => {
          const value = await readFile(resolve(workspace, "descendant.pid"), "utf8").catch(
            () => undefined,
          );
          if (value === undefined) return false;
          descendantPid = Number(value.trim());
          return Number.isSafeInteger(descendantPid) && descendantPid > 0;
        });
        if (descendantPid === undefined) throw new Error("Descendant PID was not recorded");
        expect(processExists(descendantPid)).toBe(true);

        controller.abort({
          kind: "agent-dock.turn-cancellation",
          reason: "shutdown",
          gracePeriodMs: 25,
        });
        await expect(running).rejects.toMatchObject({
          name: "PiRpcTurnCancelledError",
          reason: "shutdown",
          forced: true,
        });
        await waitFor(() => !processExists(descendantPid!), 2_000);
        expect(events.map((message) => message.payload.event.type)).toEqual([
          "turn.started",
          "turn.cancelled",
        ]);
        expect(events[1]?.payload.event).toMatchObject({
          type: "turn.cancelled",
          payload: { reason: "shutdown", forced: true },
        });
      } finally {
        if (descendantPid !== undefined && processExists(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await rm(workspace, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
