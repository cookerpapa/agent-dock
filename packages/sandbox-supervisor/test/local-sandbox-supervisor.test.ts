import type { EventPublishMessage, ExecuteTurnCommandMessage } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { LocalSandboxSupervisor, type SupervisorTurnRunner } from "../src/index.ts";

const IDS = {
  message: "11111111-1111-4111-8111-111111111111",
  command: "22222222-2222-4222-8222-222222222222",
  command2: "33333333-3333-4333-8333-333333333333",
  lease: "44444444-4444-4444-8444-444444444444",
  lease2: "55555555-5555-4555-8555-555555555555",
};

function command(
  overrides: {
    commandId?: string;
    leaseId?: string;
    fencingToken?: number;
    sessionId?: string;
  } = {},
): ExecuteTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: IDS.message,
    sentAt: "2026-07-18T08:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      commandId: overrides.commandId ?? IDS.command,
      idempotencyKey: "request-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: overrides.sessionId ?? "session-1",
      turnId: "turn-1",
      agentId: "root",
      leaseId: overrides.leaseId ?? IDS.lease,
      fencingToken: overrides.fencingToken ?? 1,
      nextEventSeq: 1,
      input: { kind: "prompt", text: "hello" },
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
}

class RecordingRunner implements SupervisorTurnRunner {
  readonly calls: ExecuteTurnCommandMessage[] = [];

  async run(value: ExecuteTurnCommandMessage): Promise<{ stopReason: string }> {
    this.calls.push(value);
    return { stopReason: "stop" };
  }
}

describe("LocalSandboxSupervisor", () => {
  it("returns a side-effect-free ACK and starts the runner only after run", async () => {
    const runner = new RecordingRunner();
    const supervisor = new LocalSandboxSupervisor({ runner });
    const prepared = supervisor.prepare(command(), () => undefined);

    expect(prepared.ack.payload).toMatchObject({ status: "accepted", fencingToken: 1 });
    expect(runner.calls).toHaveLength(0);
    expect(supervisor.activeSessionCount).toBe(1);

    await expect(prepared.run()).resolves.toEqual({ stopReason: "stop" });
    expect(runner.calls).toHaveLength(1);
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("deduplicates the same command and reuses one execution promise", async () => {
    const runner = new RecordingRunner();
    const supervisor = new LocalSandboxSupervisor({ runner });
    const first = supervisor.prepare(command(), () => undefined);
    const duplicate = supervisor.prepare(command(), () => undefined);

    expect(duplicate.ack.payload.status).toBe("duplicate");
    await Promise.all([first.run(), duplicate.run()]);
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects a reused command ID when the immutable payload changed", () => {
    const runner = new RecordingRunner();
    const supervisor = new LocalSandboxSupervisor({ runner });
    supervisor.prepare(command(), () => undefined);
    const changed = command();
    if (changed.payload.input.kind !== "prompt") throw new Error("Expected prompt input");
    changed.payload.input.text = "different prompt";

    const conflict = supervisor.prepare(changed, () => undefined);
    expect(conflict.ack.payload).toMatchObject({
      status: "rejected",
      code: "invalid_command",
      retryable: false,
    });
  });

  it("retains the high-water fence after a pre-start release", () => {
    const runner = new RecordingRunner();
    const supervisor = new LocalSandboxSupervisor({ runner });
    const current = supervisor.prepare(
      command({ leaseId: IDS.lease2, fencingToken: 2 }),
      () => undefined,
    );
    current.releaseBeforeStart();

    const stale = supervisor.prepare(command({ fencingToken: 1 }), () => undefined);
    expect(stale.ack.payload).toMatchObject({
      status: "rejected",
      code: "stale_fence",
      retryable: false,
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects capacity overflow without invoking the second command", () => {
    const runner = new RecordingRunner();
    const supervisor = new LocalSandboxSupervisor({ runner, maxConcurrentSessions: 1 });
    supervisor.prepare(command(), () => undefined);
    const overflow = supervisor.prepare(
      command({
        commandId: IDS.command2,
        leaseId: IDS.lease2,
        sessionId: "session-2",
      }),
      () => undefined,
    );

    expect(overflow.ack.payload).toMatchObject({
      status: "rejected",
      code: "capacity",
      retryable: true,
    });
  });

  it("rejects runner events with a mismatched fence", async () => {
    const badRunner: SupervisorTurnRunner = {
      async run(value, publishEvent) {
        const event = {
          protocolVersion: 1,
          messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sentAt: "2026-07-18T08:00:00.000Z",
          type: "event.publish",
          payload: {
            leaseId: value.payload.leaseId,
            fencingToken: value.payload.fencingToken + 1,
            commandId: value.payload.commandId,
            event: {
              schemaVersion: 1,
              eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              sessionId: value.payload.sessionId,
              turnId: value.payload.turnId,
              agentId: "root",
              seq: 1,
              occurredAt: "2026-07-18T08:00:00.000Z",
              type: "turn.started",
              payload: { inputKind: "prompt" },
            },
          },
        } as EventPublishMessage;
        await publishEvent(event);
        return { stopReason: "stop" };
      },
    };
    const supervisor = new LocalSandboxSupervisor({ runner: badRunner });
    const prepared = supervisor.prepare(command(), () => undefined);

    await expect(prepared.run()).rejects.toThrow("does not match its assignment");
  });
});
