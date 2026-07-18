import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import type { EventPublishMessage, ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcTurnRunner } from "../src/index.ts";

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
    turnId: "turn-1",
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
  },
};

describe("PiRpcTurnRunner integration", () => {
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
});
