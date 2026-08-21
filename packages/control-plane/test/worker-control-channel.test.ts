import {
  TWO_PHASE_COMMAND_CAPABILITY,
  PI_STEER_CAPABILITY,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type SteerTurnCommandMessage,
} from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import { WorkerControlChannelRouter, type WorkerControlConnection } from "../src/index.ts";

const IDS = {
  commandMessage: "10000000-0000-4000-8000-000000000001",
  command: "10000000-0000-4000-8000-000000000002",
  lease: "10000000-0000-4000-8000-000000000003",
  ack: "10000000-0000-4000-8000-000000000004",
  connection: "10000000-0000-4000-8000-000000000005",
  boot: "10000000-0000-4000-8000-000000000006",
  sandbox: "10000000-0000-4000-8000-000000000007",
  run: "10000000-0000-4000-8000-000000000010",
  attempt: "10000000-0000-4000-8000-000000000011",
  commit: "10000000-0000-4000-8000-000000000014",
  result: "10000000-0000-4000-8000-000000000015",
} as const;

const SENT_AT = "2026-07-19T07:00:00.000Z";

function command(): SteerTurnCommandMessage {
  const parsed = parseControlToSupervisorMessage({
    protocolVersion: 1,
    messageId: IDS.commandMessage,
    sentAt: SENT_AT,
    type: "command.turn.steer",
    payload: {
      commandId: IDS.command,
      targetCommandId: "10000000-0000-4000-8000-000000000013",
      idempotencyKey: "request-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      runId: IDS.run,
      turnId: "turn-1",
      attemptId: IDS.attempt,
      agentId: "root",
      leaseId: IDS.lease,
      fencingToken: 1,
      text: "Focus on the current Run.",
    },
  });
  if (parsed.type !== "command.turn.steer") throw new Error("Expected steer command");
  return parsed;
}

function connection(
  options: {
    capabilities?: readonly string[];
    sent?: unknown[];
  } = {},
): WorkerControlConnection {
  return {
    supervisorId: "supervisor-1",
    bootId: IDS.boot,
    sandboxId: IDS.sandbox,
    connectionId: IDS.connection,
    capabilities: options.capabilities ?? [TWO_PHASE_COMMAND_CAPABILITY, PI_STEER_CAPABILITY],
    async send(message) {
      options.sent?.push(message);
    },
  };
}

describe("Worker control channel", () => {
  it("carries a fenced steer through prepare, commit, and result", async () => {
    const sent: unknown[] = [];
    const attached = connection({ sent });
    const router = new WorkerControlChannelRouter({
      commandAckTimeoutMs: 1_000,
      commandResultTimeoutMs: 1_000,
    });
    router.attach(attached);
    const steer = command();
    const acknowledgement = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: IDS.ack,
      sentAt: SENT_AT,
      type: "command.ack",
      payload: {
        commandId: IDS.command,
        sessionId: "session-1",
        turnId: "turn-1",
        leaseId: IDS.lease,
        fencingToken: 1,
        status: "accepted",
      },
    });
    if (acknowledgement.type !== "command.ack") throw new Error("Expected acknowledgement");
    const prepared = router.prepare(IDS.sandbox, steer);
    await Promise.resolve();
    await router.receive(attached, acknowledgement);
    await expect(prepared).resolves.toEqual(acknowledgement);

    const commit = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: IDS.commit,
      sentAt: SENT_AT,
      type: "command.commit",
      payload: {
        commandId: IDS.command,
        sessionId: "session-1",
        turnId: "turn-1",
        leaseId: IDS.lease,
        fencingToken: 1,
        acknowledgedMessageId: IDS.ack,
      },
    });
    if (commit.type !== "command.commit") throw new Error("Expected commit");
    const committed = router.commit(IDS.sandbox, steer, acknowledgement, commit);
    await Promise.resolve();
    const result = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: IDS.result,
      sentAt: SENT_AT,
      type: "command.result",
      payload: {
        commandId: IDS.command,
        sessionId: "session-1",
        turnId: "turn-1",
        leaseId: IDS.lease,
        fencingToken: 1,
        commitMessageId: IDS.commit,
        commandKind: "turn.steer",
        status: "completed",
      },
    });
    await router.receive(attached, result);
    await expect(committed).resolves.toEqual(result);
    expect(sent).toEqual([steer, commit]);
  });

  it("does not send steer commands to a Worker that omitted the steer capability", async () => {
    const sent: unknown[] = [];
    const router = new WorkerControlChannelRouter({});
    router.attach(connection({ capabilities: [TWO_PHASE_COMMAND_CAPABILITY], sent }));

    await expect(router.prepare(IDS.sandbox, command())).rejects.toMatchObject({
      code: "supervisor_capability_missing",
      retryable: false,
      ambiguous: false,
    });
    expect(sent).toEqual([]);
  });

  it("rejects a mismatched ACK instead of correlating it by command ID alone", async () => {
    const sent: unknown[] = [];
    const attached = connection({ sent });
    const router = new WorkerControlChannelRouter({
      commandAckTimeoutMs: 1_000,
    });
    router.attach(attached);
    const pending = router.prepare(IDS.sandbox, command()).catch((error: unknown) => error);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    const mismatched = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: IDS.ack,
      sentAt: SENT_AT,
      type: "command.ack",
      payload: {
        commandId: IDS.command,
        sessionId: "session-1",
        turnId: "turn-1",
        leaseId: IDS.lease,
        fencingToken: 2,
        status: "accepted",
      },
    });

    await expect(router.receive(attached, mismatched)).rejects.toMatchObject({
      code: "command_ack_mismatch",
    });
    router.detach(attached);
    await expect(pending).resolves.toMatchObject({ code: "connection_closed" });
  });
});
