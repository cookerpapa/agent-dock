import type {
  EventAckMessage,
  EventPublishMessage,
  CancelTurnCommandMessage,
  ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileEventSpoolStore,
  LocalSandboxSupervisor,
  PiRpcTurnCancelledError,
  type SupervisorTurnRunner,
} from "../src/index.ts";

const IDS = {
  message: "11111111-1111-4111-8111-111111111111",
  command: "22222222-2222-4222-8222-222222222222",
  command2: "33333333-3333-4333-8333-333333333333",
  cancellation: "66666666-6666-4666-8666-666666666666",
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

function cancellation(target: ExecuteTurnCommandMessage = command()): CancelTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: "77777777-7777-4777-8777-777777777777",
    sentAt: "2026-07-18T08:00:01.000Z",
    type: "command.turn.cancel",
    payload: {
      commandId: IDS.cancellation,
      targetCommandId: target.payload.commandId,
      idempotencyKey: "cancel-1",
      tenantId: target.payload.tenantId,
      projectId: target.payload.projectId,
      workspaceId: target.payload.workspaceId,
      sessionId: target.payload.sessionId,
      turnId: target.payload.turnId,
      agentId: target.payload.agentId,
      leaseId: target.payload.leaseId,
      fencingToken: target.payload.fencingToken,
      reason: "user_request",
      gracePeriodMs: 50,
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

function rejectUnexpectedEvent(): never {
  throw new Error("Recording runner did not expect to publish an event");
}

describe("LocalSandboxSupervisor", () => {
  it("returns a side-effect-free ACK and starts the runner only after run", async () => {
    const runner = new RecordingRunner();
    const supervisor = new LocalSandboxSupervisor({ runner });
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);

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
    const first = supervisor.prepare(command(), rejectUnexpectedEvent);
    const duplicate = supervisor.prepare(command(), rejectUnexpectedEvent);

    expect(duplicate.ack.payload.status).toBe("duplicate");
    await Promise.all([first.run(), duplicate.run()]);
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects a reused command ID when the immutable payload changed", () => {
    const runner = new RecordingRunner();
    const supervisor = new LocalSandboxSupervisor({ runner });
    supervisor.prepare(command(), rejectUnexpectedEvent);
    const changed = command();
    if (changed.payload.input.kind !== "prompt") throw new Error("Expected prompt input");
    changed.payload.input.text = "different prompt";

    const conflict = supervisor.prepare(changed, rejectUnexpectedEvent);
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
      rejectUnexpectedEvent,
    );
    current.releaseBeforeStart();

    const stale = supervisor.prepare(command({ fencingToken: 1 }), rejectUnexpectedEvent);
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
    supervisor.prepare(command(), rejectUnexpectedEvent);
    const overflow = supervisor.prepare(
      command({
        commandId: IDS.command2,
        leaseId: IDS.lease2,
        sessionId: "session-2",
      }),
      rejectUnexpectedEvent,
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
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);

    await expect(prepared.run()).rejects.toThrow("does not match its assignment");
  });

  it("retains the spooled event when the control-plane ACK is invalid", async () => {
    const publishingRunner: SupervisorTurnRunner = {
      async run(value, publishEvent) {
        await publishEvent({
          protocolVersion: 1,
          messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sentAt: "2026-07-18T08:00:00.000Z",
          type: "event.publish",
          payload: {
            leaseId: value.payload.leaseId,
            fencingToken: value.payload.fencingToken,
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
        });
        return { stopReason: "stop" };
      },
    };
    const supervisor = new LocalSandboxSupervisor({ runner: publishingRunner });
    const prepared = supervisor.prepare(command(), (message): EventAckMessage => ({
      protocolVersion: 1,
      messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sentAt: "2026-07-18T08:00:00.000Z",
      type: "event.ack",
      payload: {
        sessionId: message.payload.event.sessionId,
        leaseId: message.payload.leaseId,
        fencingToken: message.payload.fencingToken,
        acknowledgedThroughSeq: 2,
      },
    }));

    await expect(prepared.run()).rejects.toThrow("acknowledgement was invalid");
  });

  it("redelivers a locally durable event through a fresh spool store after the ACK path crashes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-local-supervisor-spool-"));
    try {
      const durableStore = new FileEventSpoolStore({ rootDirectory: root });
      const event: EventPublishMessage = {
        protocolVersion: 1,
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sentAt: "2026-07-18T08:00:00.000Z",
        type: "event.publish",
        payload: {
          leaseId: IDS.lease,
          fencingToken: 1,
          commandId: IDS.command,
          event: {
            schemaVersion: 1,
            eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            sessionId: "session-1",
            turnId: "turn-1",
            agentId: "root",
            seq: 1,
            occurredAt: "2026-07-18T08:00:00.000Z",
            type: "turn.started",
            payload: { inputKind: "prompt" },
          },
        },
      };
      const publishingRunner: SupervisorTurnRunner = {
        async run(_value, publishEvent) {
          await publishEvent(event);
          return { stopReason: "stop" };
        },
      };
      let committed: EventPublishMessage | undefined;
      const supervisor = new LocalSandboxSupervisor({
        runner: publishingRunner,
        eventSpoolFactory: (options) => durableStore.open(options),
      });
      const prepared = supervisor.prepare(command(), (message) => {
        committed = message;
        throw new Error("simulated connection loss after durable commit");
      });

      await expect(prepared.run()).rejects.toThrow("simulated connection loss");
      expect(committed).toEqual(event);

      const replayed: EventPublishMessage[] = [];
      const restartedStore = new FileEventSpoolStore({ rootDirectory: root });
      const restartedSupervisor = new LocalSandboxSupervisor({
        runner: new RecordingRunner(),
        eventSpoolFactory: (options) => restartedStore.open(options),
        eventSpoolRecovery: restartedStore,
      });
      await expect(
        restartedSupervisor.recoverPendingEvents((message) => {
          replayed.push(message);
          return {
            protocolVersion: 1,
            messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            sentAt: "2026-07-18T08:00:01.000Z",
            type: "event.ack",
            payload: {
              sessionId: message.payload.event.sessionId,
              leaseId: message.payload.leaseId,
              fencingToken: message.payload.fencingToken,
              acknowledgedThroughSeq: message.payload.event.seq,
            },
          };
        }),
      ).resolves.toEqual({ scannedSpools: 1, replayedSpools: 1, replayedEvents: 1 });
      expect(replayed).toEqual([event]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares cancellation without side effects, then aborts the exact running assignment", async () => {
    let observedSignal: AbortSignal | undefined;
    const abortingRunner: SupervisorTurnRunner = {
      async run(_value, _publishEvent, signal) {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const reason = signal.reason as { reason: "user_request" };
              reject(new PiRpcTurnCancelledError(reason.reason, false));
            },
            { once: true },
          );
        });
      },
    };
    const supervisor = new LocalSandboxSupervisor({ runner: abortingRunner });
    const execute = command();
    const preparedExecution = supervisor.prepare(execute, rejectUnexpectedEvent);
    const execution = preparedExecution.run();
    void execution.catch(() => undefined);
    const preparedCancellation = supervisor.prepareCancellation(cancellation(execute));

    expect(preparedCancellation.ack.payload.status).toBe("accepted");
    expect(observedSignal?.aborted).toBe(false);
    await expect(preparedCancellation.run()).resolves.toEqual({
      reason: "user_request",
      forced: false,
    });
    await expect(execution).rejects.toBeInstanceOf(PiRpcTurnCancelledError);
    expect(observedSignal?.aborted).toBe(true);
    expect(supervisor.activeSessionCount).toBe(0);
  });
});
