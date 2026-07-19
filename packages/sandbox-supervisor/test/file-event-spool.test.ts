import {
  createAgentDockEventFactory,
  parseControlToSupervisorMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventDeliveryRejectedError, EventSpoolError, FileEventSpoolStore } from "../src/index.ts";

const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const SENT_AT = "2026-07-19T08:00:00.000Z";
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "agent-dock-event-spool-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixture(initialSequence = 0) {
  let eventNumber = 0;
  let messageNumber = 0;
  const events = createAgentDockEventFactory(
    { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
    {
      initialSequence,
      clock: () => new Date(SENT_AT),
      idGenerator: () => `${String(++eventNumber).padStart(8, "0")}-0000-4000-8000-000000000000`,
    },
  );
  const messageId = () => `${String(++messageNumber).padStart(8, "0")}-1111-4111-8111-111111111111`;
  return {
    publish(text: string): EventPublishMessage {
      return {
        protocolVersion: 1,
        messageId: messageId(),
        sentAt: SENT_AT,
        type: "event.publish",
        payload: {
          leaseId: LEASE_ID,
          fencingToken: 7,
          commandId: COMMAND_ID,
          event: events.next({ type: "assistant.text.delta", payload: { text } }),
        },
      };
    },
    ack(sequence: number) {
      return {
        protocolVersion: 1,
        messageId: messageId(),
        sentAt: SENT_AT,
        type: "event.ack",
        payload: {
          sessionId: "session-1",
          leaseId: LEASE_ID,
          fencingToken: 7,
          acknowledgedThroughSeq: sequence,
        },
      } as const;
    },
  };
}

function openOptions(acknowledgedThroughSeq = 0) {
  return {
    sessionId: "session-1",
    leaseId: LEASE_ID,
    fencingToken: 7,
    acknowledgedThroughSeq,
    maxPendingEvents: 3,
    maxPendingBytes: 1_024 * 1_024,
  };
}

describe("FileEventSpoolStore", () => {
  it("reopens a contiguous suffix in a fresh store and durably drains it by cumulative ACK", async () => {
    const root = await temporaryRoot();
    const messages = fixture();
    const first = messages.publish("one");
    const second = messages.publish("two");
    const spool = await new FileEventSpoolStore({ rootDirectory: root }).open(openOptions());

    await expect(spool.append(first)).resolves.toBe("appended");
    await expect(spool.append(second)).resolves.toBe("appended");
    await expect(spool.acknowledge(messages.ack(1))).resolves.toMatchObject({
      acknowledgedThroughSeq: 1,
      removedCount: 1,
    });

    const replayed: EventPublishMessage[] = [];
    const restarted = new FileEventSpoolStore({ rootDirectory: root });
    await expect(
      restarted.redeliverPending((message) => {
        replayed.push(message);
        return messages.ack(message.payload.event.seq);
      }),
    ).resolves.toEqual({
      scannedSpools: 1,
      replayedSpools: 1,
      replayedEvents: 1,
      quarantinedSpools: 0,
      quarantinedEvents: 0,
    });
    expect(replayed).toEqual([second]);

    const reopened = await new FileEventSpoolStore({ rootDirectory: root }).open(openOptions(2));
    expect(reopened.acknowledgedThroughSeq).toBe(2);
    expect(reopened.pendingCount).toBe(0);
    await expect(
      new FileEventSpoolStore({ rootDirectory: root }).redeliverPending(() => {
        throw new Error("An empty spool must not publish");
      }),
    ).resolves.toEqual({
      scannedSpools: 1,
      replayedSpools: 0,
      replayedEvents: 0,
      quarantinedSpools: 0,
      quarantinedEvents: 0,
    });
  });

  it("replays the exact event after a simulated commit-with-lost-ACK window", async () => {
    const root = await temporaryRoot();
    const messages = fixture();
    const event = messages.publish("committed before the ACK connection failed");
    const spool = await new FileEventSpoolStore({ rootDirectory: root }).open(openOptions());
    await spool.append(event);

    const simulatedDurableRows = new Map<number, EventPublishMessage>();
    simulatedDurableRows.set(event.payload.event.seq, event);

    const restarted = new FileEventSpoolStore({ rootDirectory: root });
    await expect(
      restarted.redeliverPending((duplicate) => {
        expect(duplicate).toEqual(simulatedDurableRows.get(duplicate.payload.event.seq));
        return messages.ack(duplicate.payload.event.seq);
      }),
    ).resolves.toMatchObject({ replayedEvents: 1 });
    expect(simulatedDurableRows.size).toBe(1);
  });

  it("atomically quarantines an exact permanently stale assignment without fabricating an ACK", async () => {
    const parent = await temporaryRoot();
    const active = resolve(parent, "active");
    const quarantine = resolve(parent, "quarantine");
    const messages = fixture();
    const first = messages.publish("one");
    const second = messages.publish("two");
    const store = new FileEventSpoolStore({
      rootDirectory: active,
      quarantineDirectory: quarantine,
      clock: () => new Date(SENT_AT),
    });
    const spool = await store.open(openOptions());
    await spool.append(first);
    await spool.append(second);

    await expect(
      store.redeliverPending((message) => {
        if (message.payload.event.seq === 1) return messages.ack(1);
        const rejected = parseControlToSupervisorMessage({
          protocolVersion: 1,
          messageId: "99999999-9999-4999-8999-999999999999",
          sentAt: SENT_AT,
          type: "event.rejected",
          payload: {
            sessionId: message.payload.event.sessionId,
            leaseId: message.payload.leaseId,
            fencingToken: message.payload.fencingToken,
            rejectedSeq: message.payload.event.seq,
            code: "stale_fence",
            retryable: false,
          },
        });
        if (rejected.type !== "event.rejected") throw new Error("Expected event rejection");
        throw new EventDeliveryRejectedError(rejected);
      }),
    ).resolves.toEqual({
      scannedSpools: 1,
      replayedSpools: 1,
      replayedEvents: 1,
      quarantinedSpools: 1,
      quarantinedEvents: 1,
    });
    expect(await readdir(active)).toEqual([]);
    const quarantined = await readdir(quarantine);
    expect(quarantined).toHaveLength(1);
    const record = JSON.parse(
      await readFile(resolve(quarantine, quarantined[0]!, "rejection.json"), "utf8"),
    ) as { format: string; rejection: Record<string, unknown> };
    expect(record).toMatchObject({
      format: "agent-dock.event-spool-rejection.v1",
      rejection: {
        sessionId: "session-1",
        leaseId: LEASE_ID,
        fencingToken: 7,
        rejectedSeq: 2,
        code: "stale_fence",
        rejectedAt: SENT_AT,
      },
    });
    await expect(
      new FileEventSpoolStore({
        rootDirectory: active,
        quarantineDirectory: quarantine,
      }).redeliverPending(() => {
        throw new Error("Quarantined spools must not replay");
      }),
    ).resolves.toMatchObject({ scannedSpools: 0, quarantinedSpools: 0 });
  });

  it("rejects conflicting duplicates, capacity overflow, and assignment-mismatched ACKs", async () => {
    const root = await temporaryRoot();
    const messages = fixture();
    const first = messages.publish("one");
    const second = messages.publish("two");
    const spool = await new FileEventSpoolStore({ rootDirectory: root }).open({
      ...openOptions(),
      maxPendingEvents: 1,
    });
    await spool.append(first);
    await expect(
      spool.append({
        ...first,
        messageId: "99999999-9999-4999-8999-999999999999",
        payload: {
          ...first.payload,
          event: { ...first.payload.event, payload: { text: "changed" } },
        },
      }),
    ).rejects.toThrow("Conflicting event publication");
    await expect(spool.append(second)).rejects.toThrow("Event spool is full at 1");
    await expect(
      spool.acknowledge({
        ...messages.ack(1),
        payload: { ...messages.ack(1).payload, fencingToken: 8 },
      }),
    ).rejects.toThrow("stale assignment");
  });

  it("fails closed when a persisted event is corrupted or a sequence file is missing", async () => {
    const corruptRoot = await temporaryRoot();
    const corruptMessages = fixture();
    const corruptSpool = await new FileEventSpoolStore({ rootDirectory: corruptRoot }).open(
      openOptions(),
    );
    await corruptSpool.append(corruptMessages.publish("one"));
    const [corruptDirectory] = await readdir(corruptRoot);
    if (corruptDirectory === undefined) throw new Error("Expected a spool directory");
    await writeFile(resolve(corruptRoot, corruptDirectory, "events", "1.json"), "corrupt\n");
    await expect(
      new FileEventSpoolStore({ rootDirectory: corruptRoot }).redeliverPending(() => {
        throw new Error("Corrupt entries must not publish");
      }),
    ).rejects.toThrow(EventSpoolError);

    const gapRoot = await temporaryRoot();
    const gapMessages = fixture();
    const gapSpool = await new FileEventSpoolStore({ rootDirectory: gapRoot }).open(openOptions());
    await gapSpool.append(gapMessages.publish("one"));
    await gapSpool.append(gapMessages.publish("two"));
    const [gapDirectory] = await readdir(gapRoot);
    if (gapDirectory === undefined) throw new Error("Expected a spool directory");
    await rm(resolve(gapRoot, gapDirectory, "events", "1.json"));
    await expect(
      new FileEventSpoolStore({ rootDirectory: gapRoot }).redeliverPending(() => {
        throw new Error("Gapped entries must not publish");
      }),
    ).rejects.toThrow("expected sequence 1, found 2");
  });
});
