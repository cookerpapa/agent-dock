import {
  createAgentDockEventFactory,
  parseControlToSupervisorMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventDeliveryRejectedError, EventSpoolError } from "../src/index.ts";
import { WalEventSpoolStore } from "../src/wal-event-spool.ts";

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

describe("WalEventSpoolStore", () => {
  it("reopens a contiguous suffix in a fresh store and durably drains it by cumulative ACK", async () => {
    const root = await temporaryRoot();
    const messages = fixture();
    const first = messages.publish("one");
    const second = messages.publish("two");
    const spool = await new WalEventSpoolStore({ rootDirectory: root }).open(openOptions());

    await expect(spool.append(first)).resolves.toBe("appended");
    await expect(spool.append(second)).resolves.toBe("appended");
    await expect(spool.acknowledge(messages.ack(1))).resolves.toMatchObject({
      acknowledgedThroughSeq: 1,
      removedCount: 1,
    });

    const replayed: EventPublishMessage[] = [];
    const restarted = new WalEventSpoolStore({ rootDirectory: root });
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

    const reopened = await new WalEventSpoolStore({ rootDirectory: root }).open(openOptions(2));
    expect(reopened.acknowledgedThroughSeq).toBe(2);
    expect(reopened.pendingCount).toBe(0);
    await expect(
      new WalEventSpoolStore({ rootDirectory: root }).redeliverPending(() => {
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
    const spool = await new WalEventSpoolStore({ rootDirectory: root }).open(openOptions());
    await spool.append(event);

    const simulatedDurableRows = new Map<number, EventPublishMessage>();
    simulatedDurableRows.set(event.payload.event.seq, event);

    const restarted = new WalEventSpoolStore({ rootDirectory: root });
    await expect(
      restarted.redeliverPending((duplicate) => {
        expect(duplicate).toEqual(simulatedDurableRows.get(duplicate.payload.event.seq));
        return messages.ack(duplicate.payload.event.seq);
      }),
    ).resolves.toMatchObject({ replayedEvents: 1 });
    expect(simulatedDurableRows.size).toBe(1);
  });

  it("truncates only an incomplete crash tail and replays the last fsynced event", async () => {
    const root = await temporaryRoot();
    const messages = fixture();
    const event = messages.publish("durable before a partial next record");
    const spool = await new WalEventSpoolStore({ rootDirectory: root }).open(openOptions());
    await spool.append(event);
    const [wal] = await readdir(root);
    if (wal === undefined) throw new Error("Expected a spool WAL");
    await appendFile(resolve(root, wal), '{"format":"agent-dock.event-spool-wal.v1"');

    const replayed: EventPublishMessage[] = [];
    await expect(
      new WalEventSpoolStore({ rootDirectory: root }).redeliverPending((message) => {
        replayed.push(message);
        return messages.ack(message.payload.event.seq);
      }),
    ).resolves.toMatchObject({ replayedEvents: 1 });
    expect(replayed).toEqual([event]);
  });

  it("atomically quarantines an exact permanently stale assignment without fabricating an ACK", async () => {
    const parent = await temporaryRoot();
    const active = resolve(parent, "active");
    const quarantine = resolve(parent, "quarantine");
    const messages = fixture();
    const first = messages.publish("one");
    const second = messages.publish("two");
    const store = new WalEventSpoolStore({
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
    const records = (await readFile(resolve(quarantine, quarantined[0]!), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            format: string;
            record: Record<string, unknown>;
          },
      );
    expect(records.at(-1)).toMatchObject({
      format: "agent-dock.event-spool-wal.v1",
      record: {
        kind: "rejection",
        sessionId: "session-1",
        leaseId: LEASE_ID,
        fencingToken: 7,
        rejectedSeq: 2,
        code: "stale_fence",
        rejectedAt: SENT_AT,
      },
    });
    await expect(
      new WalEventSpoolStore({
        rootDirectory: active,
        quarantineDirectory: quarantine,
      }).redeliverPending(() => {
        throw new Error("Quarantined spools must not replay");
      }),
    ).resolves.toMatchObject({ scannedSpools: 0, quarantinedSpools: 0 });
  });

  it("quarantines a rejection fsynced before a simulated crash without redelivery", async () => {
    const parent = await temporaryRoot();
    const active = resolve(parent, "active");
    const quarantine = resolve(parent, "quarantine");
    const messages = fixture();
    const event = messages.publish("must not be redelivered after rejection");
    const spool = await new WalEventSpoolStore({
      rootDirectory: active,
      quarantineDirectory: quarantine,
    }).open(openOptions());
    await spool.append(event);
    const rejected = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: "99999999-9999-4999-8999-999999999999",
      sentAt: SENT_AT,
      type: "event.rejected",
      payload: {
        sessionId: event.payload.event.sessionId,
        leaseId: event.payload.leaseId,
        fencingToken: event.payload.fencingToken,
        rejectedSeq: event.payload.event.seq,
        code: "stale_fence",
        retryable: false,
      },
    });
    if (rejected.type !== "event.rejected") throw new Error("Expected event rejection");
    await spool.markRejected(new EventDeliveryRejectedError(rejected), new Date(SENT_AT));

    await expect(
      new WalEventSpoolStore({
        rootDirectory: active,
        quarantineDirectory: quarantine,
      }).redeliverPending(() => {
        throw new Error("Rejected WAL must not be redelivered");
      }),
    ).resolves.toMatchObject({
      scannedSpools: 1,
      replayedEvents: 0,
      quarantinedSpools: 1,
      quarantinedEvents: 1,
    });
    expect(await readdir(active)).toEqual([]);
    expect(await readdir(quarantine)).toHaveLength(1);
  });

  it("rejects conflicting duplicates, capacity overflow, and assignment-mismatched ACKs", async () => {
    const root = await temporaryRoot();
    const messages = fixture();
    const first = messages.publish("one");
    const second = messages.publish("two");
    const spool = await new WalEventSpoolStore({ rootDirectory: root }).open({
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
    const corruptSpool = await new WalEventSpoolStore({ rootDirectory: corruptRoot }).open(
      openOptions(),
    );
    await corruptSpool.append(corruptMessages.publish("one"));
    const [corruptWal] = await readdir(corruptRoot);
    if (corruptWal === undefined) throw new Error("Expected a spool WAL");
    await writeFile(resolve(corruptRoot, corruptWal), "corrupt\n");
    await expect(
      new WalEventSpoolStore({ rootDirectory: corruptRoot }).redeliverPending(() => {
        throw new Error("Corrupt entries must not publish");
      }),
    ).rejects.toThrow(EventSpoolError);

    const gapRoot = await temporaryRoot();
    const gapMessages = fixture();
    const gapSpool = await new WalEventSpoolStore({ rootDirectory: gapRoot }).open(openOptions());
    await gapSpool.append(gapMessages.publish("one"));
    await gapSpool.append(gapMessages.publish("two"));
    const [gapWal] = await readdir(gapRoot);
    if (gapWal === undefined) throw new Error("Expected a spool WAL");
    const gapPath = resolve(gapRoot, gapWal);
    const walLines = (await readFile(gapPath, "utf8")).trim().split("\n");
    await writeFile(gapPath, `${[walLines[0], ...walLines.slice(2)].join("\n")}\n`);
    await expect(
      new WalEventSpoolStore({ rootDirectory: gapRoot }).redeliverPending(() => {
        throw new Error("Gapped entries must not publish");
      }),
    ).rejects.toThrow("expected sequence 1, found 2");
  });
});
