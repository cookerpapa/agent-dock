import { FAKE_MODEL_API_KEY, FakeModelServer } from "@agent-dock/fake-model-server";
import type { EventPublishMessage, ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcTurnCancelledError, PiRpcTurnRunner } from "../src/index.ts";

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

  it("aborts a live Pi model request and publishes cancellation only after teardown", async () => {
    const fakeModel = new FakeModelServer({ defaultScenario: "timeout" });
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-runner-cancel-test-"));
    const events: EventPublishMessage[] = [];
    const controller = new AbortController();
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
