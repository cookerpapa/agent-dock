import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import type { CloudAgentExecutionAuthority } from "@agent-dock/pi-session-postgres";
import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createCloudAttemptContext,
  createCloudStepContext,
  createCloudTurnContext,
  PiCloudTurnRunner,
} from "../src/index.ts";

const command: ExecuteTurnCommandMessage = {
  protocolVersion: 1,
  messageId: "11111111-1111-4111-8111-111111111111",
  sentAt: "2026-08-14T08:00:00.000Z",
  type: "command.turn.execute",
  payload: {
    commandId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "cloud-runner-integration",
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
    nextEventSeq: 1,
    input: { kind: "prompt", text: "Return the deterministic fake response." },
    sandboxRetention: "ephemeral",
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

class TestAuthority implements CloudAgentExecutionAuthority {
  readonly signal = new AbortController().signal;
  closed = false;
  async assertCurrent(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("PiCloudTurnRunner integration", () => {
  it("executes the native Pi loop from SessionStorage and publishes reviewed events", async () => {
    const fake = new FakeModelServer();
    await fake.start();
    const session = new Session(
      new InMemorySessionStorage({ id: command.payload.sessionId, createdAt: Date.now() }),
    );
    const authority = new TestAuthority();
    const events: EventPublishMessage[] = [];
    const turn = createCloudTurnContext(command, undefined);
    const attempt = createCloudAttemptContext({
      command,
      runtimeIdentity: {
        supervisorId: "supervisor-cloud-test",
        bootId: "77777777-7777-4777-8777-777777777778",
        sandboxId: "sandbox-cloud-test",
      },
      turnContextSha256: turn.sha256,
    });
    let stepSequence = 0;
    let authorityWasActiveAtSettlement = false;
    const sourceEvents: string[] = [];
    const runner = new PiCloudTurnRunner({
      resolveModelRuntime: () => ({
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        baseUrl: fake.baseUrl,
        api: "openai-completions",
        apiKey: FAKE_MODEL_API_KEY,
        contextWindow: 131_072,
      }),
      openSession: async () => ({ session, authority }),
      sandboxContinuity: {
        activationId: "88888888-8888-4888-8888-888888888888",
        continuity: "cold_restore",
        environmentSha256: turn.environmentSha256,
        committedWorkspaceRevision: null,
        toolPolicySha256: turn.toolPolicySha256,
      },
      createAgentTools: ({ captureSamplingStep, stepWorldState }) => ({
        tools: [],
        async systemPrompt(base) {
          return base;
        },
        async transformContext(messages, purpose = "agent") {
          await captureSamplingStep(
            async () => {
              const captured = await stepWorldState.capture();
              return {
                step: createCloudStepContext({
                  sequence: (stepSequence += 1),
                  turnContextSha256: turn.sha256,
                  attemptContextSha256: attempt.sha256,
                  activeTools: ["read", "write", "edit", "bash"],
                  worldState: captured.worldState,
                }),
                modelMessages: captured.modelMessages,
              };
            },
            { publishEvent: purpose === "agent" },
          );
          return messages;
        },
        async transformHeaders(headers = {}) {
          return headers;
        },
      }),
      observeEvent(event) {
        sourceEvents.push(
          event.type === "message_end" && event.message.role === "assistant"
            ? `${event.type}:${event.message.errorMessage ?? event.message.stopReason}`
            : event.type,
        );
      },
      onSettled() {
        authorityWasActiveAtSettlement = !authority.closed;
      },
    });

    try {
      const result = await runner
        .run(command, (event) => {
          events.push(event);
        })
        .catch((error: unknown) => {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}: ${sourceEvents.join(",")}`,
          );
        });
      expect(result.stopReason).toBe("stop");
      expect(events.map((event) => event.payload.event.type)).toContain("turn.started");
      expect(events.map((event) => event.payload.event.type)).toContain("assistant.text.delta");
      expect(events.map((event) => event.payload.event.type)).toContain("model.sampling.completed");
      expect((await session.getStats()).messageCount).toBe(2);
      expect(authorityWasActiveAtSettlement).toBe(true);
      expect(authority.closed).toBe(true);
    } finally {
      await fake.stop();
    }
  });
});
