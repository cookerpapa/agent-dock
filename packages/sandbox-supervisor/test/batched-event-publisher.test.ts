import type {
  EventAckMessage,
  EventPublishBatchMessage,
  EventPublishMessage,
} from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import { BatchedEventPublisher, InMemoryEventSpool } from "../src/index.ts";

const SESSION_ID = "session-batched-publisher";
const LEASE_ID = "11111111-1111-4111-8111-111111111111";

function publication(sequence: number): EventPublishMessage {
  const suffix = String(sequence).padStart(12, "0");
  return {
    protocolVersion: 1,
    messageId: `20000000-0000-4000-8000-${suffix}`,
    sentAt: "2026-07-21T00:00:00.000Z",
    type: "event.publish",
    payload: {
      commandId: "30000000-0000-4000-8000-000000000001",
      leaseId: LEASE_ID,
      fencingToken: 7,
      event: {
        schemaVersion: 1,
        eventId: `40000000-0000-4000-8000-${suffix}`,
        sessionId: SESSION_ID,
        turnId: "50000000-0000-4000-8000-000000000001",
        agentId: "root",
        seq: sequence,
        occurredAt: "2026-07-21T00:00:00.000Z",
        type: "assistant.text.delta",
        payload: { text: "x" },
      },
    },
  };
}

describe("BatchedEventPublisher", () => {
  it("decouples production and cumulatively ACKs contiguous batches", async () => {
    const spool = new InMemoryEventSpool({
      sessionId: SESSION_ID,
      leaseId: LEASE_ID,
      fencingToken: 7,
    });
    const batches: EventPublishBatchMessage[] = [];
    const publisher = new BatchedEventPublisher({
      spool,
      maximumBatchEvents: 64,
      batchWindowMs: 1_000,
      idGenerator: () => "60000000-0000-4000-8000-000000000001",
      clock: () => new Date("2026-07-21T00:00:00.000Z"),
      async publish(message): Promise<EventAckMessage> {
        if (message.type !== "event.publish_batch") throw new Error("Expected a batch");
        batches.push(message);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return {
          protocolVersion: 1,
          messageId: "70000000-0000-4000-8000-000000000001",
          sentAt: "2026-07-21T00:00:00.000Z",
          type: "event.ack",
          payload: {
            sessionId: SESSION_ID,
            leaseId: LEASE_ID,
            fencingToken: 7,
            acknowledgedThroughSeq: message.payload.events.at(-1)!.seq,
          },
        };
      },
    });

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      const message = publication(sequence);
      spool.append(message);
      await publisher.enqueue(message);
    }
    expect(spool.highestProducedSeq).toBe(100);
    await expect(publisher.drainToDurableBarrier()).resolves.toEqual({
      sessionId: SESSION_ID,
      acknowledgedThroughSeq: 100,
    });

    expect(batches.map((batch) => batch.payload.events.length)).toEqual([64, 36]);
    expect(batches.flatMap((batch) => batch.payload.events.map((event) => event.seq))).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(spool.acknowledgedThroughSeq).toBe(100);
    expect(spool.pendingCount).toBe(0);
  });
});
