import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSdkTurnRunner } from "../src/index.ts";

const command: ExecuteTurnCommandMessage = {
  protocolVersion: 1,
  messageId: "11111111-1111-4111-8111-111111111111",
  sentAt: "2026-07-25T08:00:00.000Z",
  type: "command.turn.execute",
  payload: {
    commandId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "sdk-runner-integration",
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

describe("PiSdkTurnRunner integration", () => {
  it("runs the direct SDK without exposing its runtime credential", async () => {
    const fakeModel = new FakeModelServer();
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-sdk-runner-test-"));
    const events: EventPublishMessage[] = [];
    try {
      await fakeModel.start();
      const result = await new PiSdkTurnRunner({
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
        }),
      }).run(command, (event) => {
        events.push(event);
      });

      expect(result).toEqual({ stopReason: "stop" });
      expect(events.map((event) => event.payload.event.type)).toEqual([
        "turn.started",
        "assistant.text.delta",
        "assistant.text.delta",
        "turn.completed",
      ]);
      expect(JSON.stringify(events)).not.toContain(FAKE_MODEL_API_KEY);
      expect(JSON.stringify(events)).not.toContain("Return the deterministic fake response.");
      expect(fakeModel.observations).toHaveLength(1);
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("captures native JSONL and restores it in a fresh SDK activation", async () => {
    const fakeModel = new FakeModelServer();
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-sdk-rehydrate-test-"));
    let checkpoint: Uint8Array | undefined;
    try {
      await fakeModel.start();
      const baseOptions = {
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model: ExecuteTurnCommandMessage["payload"]["model"]) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions" as const,
          apiKey: FAKE_MODEL_API_KEY,
        }),
      };
      await new PiSdkTurnRunner({
        ...baseOptions,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
        },
      }).run(command, () => undefined);
      expect(Buffer.from(checkpoint!).toString("utf8")).toContain('"role":"assistant"');

      const followUp: ExecuteTurnCommandMessage = {
        ...command,
        messageId: "11111111-1111-4111-8111-111111111112",
        payload: {
          ...command.payload,
          commandId: "22222222-2222-4222-8222-222222222223",
          idempotencyKey: "sdk-runner-follow-up",
          turnId: "turn-2",
          fencingToken: 8,
          nextEventSeq: 9,
          input: { kind: "prompt", text: "Continue from the prior turn." },
        },
      };
      await new PiSdkTurnRunner({
        ...baseOptions,
        restorePiSession: checkpoint!,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
        },
      }).run(followUp, () => undefined);

      expect(fakeModel.observations).toHaveLength(2);
      expect(fakeModel.observations[1]!.messageCount).toBeGreaterThan(
        fakeModel.observations[0]!.messageCount,
      );
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves a native threshold compaction across fresh SDK activations", async () => {
    const fakeModel = new FakeModelServer({ promptTokens: 3_500 });
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-sdk-compaction-test-"));
    let checkpoint: Uint8Array | undefined;
    try {
      await fakeModel.start();
      const baseOptions = {
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
      const compactingCommand: ExecuteTurnCommandMessage = {
        ...command,
        messageId: "11111111-1111-4111-8111-111111111121",
        payload: {
          ...command.payload,
          commandId: "22222222-2222-4222-8222-222222222231",
          idempotencyKey: "sdk-native-compaction",
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
      await new PiSdkTurnRunner({
        ...baseOptions,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
        },
      }).run(compactingCommand, () => undefined);

      const events: EventPublishMessage[] = [];
      await new PiSdkTurnRunner({
        ...baseOptions,
        restorePiSession: checkpoint!,
        onSettled: ({ piSession }) => {
          checkpoint = piSession;
        },
      }).run(
        {
          ...compactingCommand,
          messageId: "11111111-1111-4111-8111-111111111122",
          payload: {
            ...compactingCommand.payload,
            commandId: "22222222-2222-4222-8222-222222222232",
            idempotencyKey: "sdk-native-compaction-followup",
            turnId: "turn-compaction-2",
            fencingToken: 8,
            nextEventSeq: 20,
            input: { kind: "prompt", text: `second compactable turn ${"recent ".repeat(1_200)}` },
          },
        },
        (event) => {
          events.push(event);
        },
      );
      const compacted = Buffer.from(checkpoint!).toString("utf8");
      const compactionId = compacted
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; id?: string })
        .find((entry) => entry.type === "compaction")?.id;
      expect(compactionId).toBeTypeOf("string");
      expect(events.map((event) => event.payload.event.type)).toEqual(
        expect.arrayContaining(["context.compaction.started", "context.compaction.completed"]),
      );

      let restored: Uint8Array | undefined;
      await new PiSdkTurnRunner({
        ...baseOptions,
        restorePiSession: checkpoint!,
        onSettled: ({ piSession }) => {
          restored = piSession;
        },
      }).run(
        {
          ...compactingCommand,
          messageId: "11111111-1111-4111-8111-111111111123",
          payload: {
            ...compactingCommand.payload,
            commandId: "22222222-2222-4222-8222-222222222233",
            idempotencyKey: "sdk-native-compaction-restored",
            turnId: "turn-compaction-3",
            fencingToken: 9,
            nextEventSeq: 40,
            input: { kind: "prompt", text: "Prove the compacted session survived." },
          },
        },
        () => undefined,
      );
      expect(Buffer.from(restored!).toString("utf8")).toContain(`"id":"${compactionId!}"`);
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("cooperatively aborts a live SDK model request", async () => {
    const fakeModel = new FakeModelServer({ defaultScenario: "timeout" });
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-sdk-cancel-test-"));
    const events: EventPublishMessage[] = [];
    const controller = new AbortController();
    try {
      await fakeModel.start();
      const running = new PiSdkTurnRunner({
        resolveWorkspaceDirectory: () => workspace,
        resolveModelRuntime: (model) => ({
          provider: model.provider,
          modelId: model.modelId,
          baseUrl: fakeModel.baseUrl,
          api: "openai-completions",
          apiKey: FAKE_MODEL_API_KEY,
        }),
        turnTimeoutMs: 20_000,
      }).run(
        command,
        (event) => {
          events.push(event);
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
      });
      expect(events.map((event) => event.payload.event.type)).toEqual([
        "turn.started",
        "turn.cancelled",
      ]);
      await waitFor(() => fakeModel.observations[0]?.completion === "client_aborted");
    } finally {
      await fakeModel.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
