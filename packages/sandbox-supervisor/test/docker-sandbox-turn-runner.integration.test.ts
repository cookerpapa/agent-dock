import type {
  AgentDockEvent,
  EventPublishMessage,
  ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DockerSandboxTurnRunner,
  PiRpcTurnCancelledError,
  type CapturedSandboxCheckpoint,
  type DockerSandboxContainerIdentity,
  type LoadedSandboxCheckpoint,
  type PiRpcCancellationSignal,
  type SandboxCheckpointStore,
} from "../src/index.ts";

const dockerEnabled = process.env.AGENT_DOCK_DOCKER_SANDBOX_TEST === "1";
const dockerCommand = process.env.AGENT_DOCK_DOCKER_COMMAND ?? "docker";
const dockerImage = process.env.AGENT_DOCK_DOCKER_IMAGE ?? "agent-dock/pi-workspace:phase2";

type DockerInspection = {
  Config?: {
    User?: string;
    Env?: string[];
    Labels?: Record<string, string>;
  };
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    NetworkMode?: string;
    Init?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    PidsLimit?: number;
    Memory?: number;
    NanoCpus?: number;
    Tmpfs?: Record<string, string>;
    Binds?: string[] | null;
    PortBindings?: Record<string, unknown>;
    Devices?: unknown[];
    Privileged?: boolean;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }>;
};

function executeDocker(args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      dockerCommand,
      [...args],
      { encoding: "utf8", maxBuffer: 1_024 * 1_024, timeout: 15_000 },
      (error, stdout) => {
        resolvePromise({
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          stdout,
        });
      },
    );
  });
}

async function inspectContainer(name: string): Promise<DockerInspection> {
  const result = await executeDocker(["inspect", name]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as unknown;
  expect(parsed).toBeInstanceOf(Array);
  expect(parsed).toHaveLength(1);
  return (parsed as DockerInspection[])[0]!;
}

async function expectContainerAbsent(name: string): Promise<void> {
  const result = await executeDocker(["inspect", "--format", "{{.Id}}", name]);
  expect(result.code).not.toBe(0);
  expect(result.stdout.trim()).toBe("");
}

function assertHardenedContainer(
  identity: DockerSandboxContainerIdentity,
  inspection: DockerInspection,
): void {
  const config = inspection.Config;
  const host = inspection.HostConfig;
  expect(config?.User).toBe("1000:1000");
  expect(host?.ReadonlyRootfs).toBe(true);
  expect(host?.NetworkMode).toBe("none");
  expect(host?.Init).toBe(true);
  expect(host?.CapDrop).toContain("ALL");
  expect(host?.SecurityOpt).toContain("no-new-privileges:true");
  expect(host?.PidsLimit).toBe(128);
  expect(host?.Memory).toBe(768 * 1_024 * 1_024);
  expect(host?.NanoCpus).toBe(1_000_000_000);
  expect(host?.Privileged).toBe(false);
  expect(host?.Binds ?? []).toHaveLength(0);
  expect(Object.keys(host?.PortBindings ?? {})).toHaveLength(0);
  expect(host?.Devices ?? []).toHaveLength(0);
  expect(inspection.Mounts ?? []).toHaveLength(0);
  expect(host?.Tmpfs?.["/tmp"]).toMatch(/(?:^|,)noexec(?:,|$)/);
  expect(host?.Tmpfs?.["/tmp"]).toMatch(/(?:^|,)size=(?:64m|67108864)(?:,|$)/);
  expect(host?.Tmpfs?.["/workspace"]).toMatch(/(?:^|,)size=(?:128m|134217728)(?:,|$)/);
  expect(config?.Labels?.["agent-dock.managed"]).toBe("true");
  expect(config?.Labels?.["agent-dock.command-id"]).toBe(identity.commandId);
  expect(config?.Labels?.["agent-dock.session-id"]).toBe(identity.sessionId);
  expect(config?.Env ?? []).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/api[_-]?key|token|secret|password|credential|auth/i),
    ]),
  );
}

function command(index: number): ExecuteTurnCommandMessage {
  const digit = String(index).padStart(12, "0");
  return {
    protocolVersion: 1,
    messageId: `10000000-0000-4000-8000-${digit}`,
    sentAt: "2026-07-19T00:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      commandId: `20000000-0000-4000-8000-${digit}`,
      idempotencyKey: `docker-integration-${index}`,
      tenantId: "tenant-docker-integration",
      projectId: "project-docker-integration",
      workspaceId: "workspace-docker-integration",
      sessionId: `session-docker-integration-${index}`,
      turnId: `turn-docker-integration-${index}`,
      agentId: "root",
      leaseId: `30000000-0000-4000-8000-${digit}`,
      fencingToken: index,
      nextEventSeq: 1,
      input: { kind: "prompt", text: "Run the test, repair the Java bug, and verify it." },
      model: {
        profileId: "profile-docker-integration",
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        thinkingLevel: "off",
        credentialBindingId: "credential-docker-integration",
        credentialBindingVersion: 1,
      },
    },
  };
}

function eventsFrom(messages: readonly EventPublishMessage[]): AgentDockEvent[] {
  return messages.map((message) => message.payload.event);
}

class MemoryCheckpointStore implements SandboxCheckpointStore {
  checkpoint: LoadedSandboxCheckpoint | undefined;
  saves = 0;

  async load(): Promise<LoadedSandboxCheckpoint | undefined> {
    return this.checkpoint === undefined
      ? undefined
      : {
          revision: this.checkpoint.revision,
          piSession: this.checkpoint.piSession.slice(),
          workspace: this.checkpoint.workspace.slice(),
        };
  }

  async save(
    _command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    checkpoint: CapturedSandboxCheckpoint,
  ): Promise<{ revision: string }> {
    expect(baseRevision).toBe(this.checkpoint?.revision ?? null);
    this.saves += 1;
    const revision = `memory-checkpoint-${String(this.saves)}`;
    this.checkpoint = {
      revision,
      piSession: checkpoint.piSession.slice(),
      workspace: checkpoint.workspace.slice(),
    };
    return { revision };
  }
}

describe.skipIf(!dockerEnabled)("DockerSandboxTurnRunner Docker integration", () => {
  it("rehydrates Pi conversation and workspace into a fresh follow-up container", async () => {
    const store = new MemoryCheckpointStore();
    const firstMessages: EventPublishMessage[] = [];
    const containerNames: string[] = [];
    const firstCommand = command(3);
    const firstRunner = new DockerSandboxTurnRunner({
      image: dockerImage,
      dockerCommand,
      scenario: "java_repair",
      checkpointStore: store,
      executionTimeoutMs: 60_000,
      onContainerReady: ({ containerName }) => {
        containerNames.push(containerName);
      },
    });
    await firstRunner.run(
      firstCommand,
      (message) => {
        firstMessages.push(message);
      },
      new AbortController().signal,
    );
    const firstEvents = eventsFrom(firstMessages);
    expect(store.saves).toBe(1);
    expect(store.checkpoint).toBeDefined();
    expect(firstEvents.at(-1)?.type).toBe("turn.completed");

    const nextSequence = (firstEvents.at(-1)?.seq ?? 0) + 1;
    const secondCommand: ExecuteTurnCommandMessage = {
      ...firstCommand,
      messageId: "10000000-0000-4000-8000-000000000030",
      payload: {
        ...firstCommand.payload,
        commandId: "20000000-0000-4000-8000-000000000030",
        idempotencyKey: "docker-integration-followup",
        turnId: "turn-docker-integration-followup",
        leaseId: "30000000-0000-4000-8000-000000000030",
        fencingToken: firstCommand.payload.fencingToken + 1,
        nextEventSeq: nextSequence,
        input: { kind: "prompt", text: "Verify the previous repair after a cold activation." },
      },
    };
    const secondMessages: EventPublishMessage[] = [];
    const secondRunner = new DockerSandboxTurnRunner({
      image: dockerImage,
      dockerCommand,
      scenario: "java_followup",
      checkpointStore: store,
      executionTimeoutMs: 60_000,
      onContainerReady: ({ containerName }) => {
        containerNames.push(containerName);
      },
    });
    await secondRunner.run(
      secondCommand,
      (message) => {
        secondMessages.push(message);
      },
      new AbortController().signal,
    );

    expect(store.saves).toBe(2);
    expect(containerNames).toHaveLength(2);
    expect(new Set(containerNames).size).toBe(2);
    const secondEvents = eventsFrom(secondMessages);
    expect(secondEvents[0]?.seq).toBe(nextSequence);
    expect(
      secondEvents
        .filter((event) => event.type === "tool.started")
        .map((event) => event.payload.toolName),
    ).toEqual(["bash"]);
    expect(secondEvents.find((event) => event.type === "tool.completed")).toMatchObject({
      payload: { isError: false },
    });
    expect(
      secondEvents
        .filter((event) => event.type === "assistant.text.delta")
        .map((event) => event.payload.text)
        .join(""),
    ).toContain("Prior conversation and Java repair restored");
    const terminal = secondEvents.at(-1);
    expect(terminal?.type).toBe("turn.completed");
    if (terminal?.type !== "turn.completed") throw new Error("Expected a completed follow-up");
    expect(terminal.payload.workspacePatch?.patch).toContain("+        return left + right;");
    await Promise.all(containerNames.map((name) => expectContainerAbsent(name)));
  }, 120_000);

  it("repairs and verifies Java inside a hardened ephemeral Pi container", async () => {
    const messages: EventPublishMessage[] = [];
    let identity: DockerSandboxContainerIdentity | undefined;
    const runner = new DockerSandboxTurnRunner({
      image: dockerImage,
      dockerCommand,
      scenario: "java_repair",
      executionTimeoutMs: 60_000,
      onContainerReady: async (containerIdentity) => {
        identity = containerIdentity;
        assertHardenedContainer(
          containerIdentity,
          await inspectContainer(containerIdentity.containerName),
        );
      },
    });

    const result = await runner.run(
      command(1),
      (message) => {
        messages.push(message);
      },
      new AbortController().signal,
    );

    expect(result.stopReason).toBe("stop");
    expect(identity).toBeDefined();
    const events = eventsFrom(messages);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events[0]?.type).toBe("turn.started");
    expect(events.at(-1)?.type).toBe("turn.completed");
    const toolStarts = events.filter((event) => event.type === "tool.started");
    const toolCompletions = events.filter((event) => event.type === "tool.completed");
    expect(toolStarts.map((event) => event.payload.toolName)).toEqual(["bash", "edit", "bash"]);
    expect(toolCompletions).toHaveLength(3);
    // The first failing test is the observation that drives the repair. The
    // edit and the verification test must then succeed.
    expect(toolCompletions.map((event) => event.payload.isError)).toEqual([true, false, false]);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("turn.completed");
    if (terminal?.type !== "turn.completed") throw new Error("Expected completed terminal event");
    expect(terminal.payload.workspacePatch).toMatchObject({
      format: "unified_diff",
      truncated: false,
    });
    expect(terminal.payload.workspacePatch?.patch).toContain("-        return left - right;");
    expect(terminal.payload.workspacePatch?.patch).toContain("+        return left + right;");
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("agent-dock-test-key");
    expect(serialized).not.toContain("credential-docker-integration");
    await expectContainerAbsent(identity!.containerName);
  }, 90_000);

  it("cancels a blocked Pi turn and confirms the outer container is gone", async () => {
    const messages: EventPublishMessage[] = [];
    const abortController = new AbortController();
    let identity: DockerSandboxContainerIdentity | undefined;
    const runner = new DockerSandboxTurnRunner({
      image: dockerImage,
      dockerCommand,
      scenario: "timeout",
      executionTimeoutMs: 30_000,
      onContainerReady: async (containerIdentity) => {
        identity = containerIdentity;
        assertHardenedContainer(
          containerIdentity,
          await inspectContainer(containerIdentity.containerName),
        );
      },
    });

    const run = runner.run(
      command(2),
      (message) => {
        messages.push(message);
        if (message.payload.event.type === "turn.started" && !abortController.signal.aborted) {
          const cancellation: PiRpcCancellationSignal = {
            kind: "agent-dock.turn-cancellation",
            reason: "user_request",
            gracePeriodMs: 1_000,
          };
          abortController.abort(cancellation);
        }
      },
      abortController.signal,
    );

    await expect(run).rejects.toBeInstanceOf(PiRpcTurnCancelledError);
    expect(identity).toBeDefined();
    const events = eventsFrom(messages);
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.cancelled"]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.cancelled",
      payload: { reason: "user_request" },
    });
    await expectContainerAbsent(identity!.containerName);
  }, 60_000);
});
