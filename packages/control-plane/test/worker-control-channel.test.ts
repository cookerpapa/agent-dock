import {
  TWO_PHASE_COMMAND_CAPABILITY,
  PI_STEER_CAPABILITY,
  createAgentDockEventFactory,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
  type SteerTurnCommandMessage,
} from "@agent-dock/protocol";
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
  event: "10000000-0000-4000-8000-000000000008",
  eventMessage: "10000000-0000-4000-8000-000000000009",
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

function event(commandMessage = command()): EventPublishMessage {
  const factory = createAgentDockEventFactory(
    {
      sessionId: commandMessage.payload.sessionId,
      turnId: commandMessage.payload.turnId,
      agentId: commandMessage.payload.agentId,
    },
    { clock: () => new Date(SENT_AT), idGenerator: () => IDS.event },
  );
  const parsed = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: IDS.eventMessage,
    sentAt: SENT_AT,
    type: "event.publish",
    payload: {
      commandId: commandMessage.payload.commandId,
      leaseId: commandMessage.payload.leaseId,
      fencingToken: commandMessage.payload.fencingToken,
      event: factory.next({ type: "turn.started", payload: { inputKind: "prompt" } }),
    },
  });
  if (parsed.type !== "event.publish") throw new Error("Expected event publication");
  return parsed;
}

function connection(
  options: {
    capabilities?: readonly string[];
    sent?: unknown[];
    assertEventAuthority?: (message: EventPublishMessage) => Promise<void>;
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
    assertEventAuthority:
      options.assertEventAuthority ??
      (async () => {
        return undefined;
      }),
  };
}

describe("Worker control channel", () => {
  it("carries a fenced steer through prepare, commit, and result", async () => {
    const sent: unknown[] = [];
    const attached = connection({ sent });
    const router = new WorkerControlChannelRouter({
      eventIngestor: {
        async ingest() {
          throw new Error("events are not expected");
        },
      },
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
    const router = new WorkerControlChannelRouter({
      eventIngestor: {
        async ingest() {
          throw new Error("events are not expected");
        },
      },
    });
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
      eventIngestor: {
        async ingest() {
          throw new Error("events are not expected");
        },
      },
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

  it("checks sandbox lease authority before an event reaches durable ingestion", async () => {
    let ingested = 0;
    const authorityError = new Error("forged sandbox lease");
    const attached = connection({
      assertEventAuthority: async () => {
        throw authorityError;
      },
    });
    const router = new WorkerControlChannelRouter({
      eventIngestor: {
        async ingest() {
          ingested += 1;
          throw new Error("must not ingest unauthorized event");
        },
      },
    });
    router.attach(attached);

    await expect(router.receive(attached, event())).rejects.toBe(authorityError);
    expect(ingested).toBe(0);
  });
});
