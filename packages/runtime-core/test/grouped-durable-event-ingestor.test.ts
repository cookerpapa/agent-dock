import type { EventAckMessage, EventPublishMessage } from "@pi-cloud/protocol";
import { describe, expect, it, vi } from "vitest";
import type { DurableEventGroupIngestor } from "../src/durable-event-store.ts";
import { GroupedDurableEventIngestor } from "../src/grouped-durable-event-ingestor.ts";
import { HttpDurableEventIngestError } from "../src/http-durable-event-ingestor.ts";

function publication(sessionId: string, sequence = 1): EventPublishMessage {
  const occurredAt = new Date().toISOString();
  return {
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: occurredAt,
    type: "event.publish",
    payload: {
      leaseId: globalThis.crypto.randomUUID(),
      fencingToken: 1,
      event: {
        schemaVersion: 1,
        eventId: globalThis.crypto.randomUUID(),
        sessionId,
        turnId: null,
        agentId: "test-worker",
        seq: sequence,
        occurredAt,
        type: "session.state.changed",
        payload: { from: "running", to: "running" },
      },
    },
  };
}

function acknowledgement(message: EventPublishMessage): EventAckMessage {
  return {
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type: "event.ack",
    payload: {
      sessionId: message.payload.event.sessionId,
      leaseId: message.payload.leaseId,
      fencingToken: message.payload.fencingToken,
      acknowledgedThroughSeq: message.payload.event.seq,
    },
  };
}

describe("GroupedDurableEventIngestor", () => {
  it("resolves publications only after one grouped durable commit", async () => {
    let release!: () => void;
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    const messages = [
      publication(globalThis.crypto.randomUUID()),
      publication(globalThis.crypto.randomUUID()),
    ];
    const store: DurableEventGroupIngestor = {
      ingest: vi.fn(async (value: unknown) => acknowledgement(value as EventPublishMessage)),
      ingestGroup: vi.fn(async (values: readonly unknown[]) => {
        await durable;
        return values.map((value) => acknowledgement(value as EventPublishMessage));
      }),
    };
    const ingestor = new GroupedDurableEventIngestor({
      store,
      shardCount: 1,
      maximumGroupSize: 2,
      maximumDelayMs: 100,
    });

    let acknowledged = false;
    const pending = Promise.all(messages.map((message) => ingestor.ingest(message))).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    release();
    await pending;
    expect(store.ingestGroup).toHaveBeenCalledOnce();
    expect(store.ingest).not.toHaveBeenCalled();
  });

  it("isolates a bad publication after an atomic group rejection", async () => {
    const first = publication(globalThis.crypto.randomUUID());
    const second = publication(globalThis.crypto.randomUUID());
    const store: DurableEventGroupIngestor = {
      ingest: vi.fn(async (value: unknown) => {
        const message = value as EventPublishMessage;
        if (message.payload.event.sessionId === first.payload.event.sessionId) {
          throw new Error("invalid first stream");
        }
        return acknowledgement(message);
      }),
      ingestGroup: vi.fn(async () => Promise.reject(new Error("atomic group rejected"))),
    };
    const ingestor = new GroupedDurableEventIngestor({
      store,
      shardCount: 1,
      maximumGroupSize: 2,
      maximumDelayMs: 100,
    });

    const results = await Promise.allSettled([ingestor.ingest(first), ingestor.ingest(second)]);
    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    expect(store.ingest).toHaveBeenCalledTimes(2);
  });

  it("does not amplify a retryable shared dependency outage into individual requests", async () => {
    const messages = [
      publication(globalThis.crypto.randomUUID()),
      publication(globalThis.crypto.randomUUID()),
    ];
    const store: DurableEventGroupIngestor = {
      ingest: vi.fn(async (value: unknown) => acknowledgement(value as EventPublishMessage)),
      ingestGroup: vi.fn(async () => {
        throw new HttpDurableEventIngestError(503, "Kafka is unavailable");
      }),
    };
    const ingestor = new GroupedDurableEventIngestor({
      store,
      shardCount: 1,
      maximumGroupSize: 2,
      maximumDelayMs: 100,
      maximumRetryAttempts: 3,
      retryBaseDelayMs: 1,
    });

    const results = await Promise.allSettled(messages.map((message) => ingestor.ingest(message)));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(store.ingestGroup).toHaveBeenCalledTimes(3);
    expect(store.ingest).not.toHaveBeenCalled();
  });

  it("retries the same durable event identities after a transient group failure", async () => {
    const message = publication(globalThis.crypto.randomUUID());
    let attempts = 0;
    const store: DurableEventGroupIngestor = {
      ingest: vi.fn(async (value: unknown) => acknowledgement(value as EventPublishMessage)),
      ingestGroup: vi.fn(async (values: readonly unknown[]) => {
        attempts += 1;
        if (attempts === 1) throw new HttpDurableEventIngestError(503, "temporary deadlock");
        return values.map((value) => acknowledgement(value as EventPublishMessage));
      }),
    };
    const ingestor = new GroupedDurableEventIngestor({
      store,
      shardCount: 1,
      maximumGroupSize: 1,
      maximumDelayMs: 100,
      maximumRetryAttempts: 3,
      retryBaseDelayMs: 1,
    });

    await expect(ingestor.ingest(message)).resolves.toMatchObject({
      payload: { acknowledgedThroughSeq: 1 },
    });
    expect(store.ingestGroup).toHaveBeenCalledTimes(2);
    expect(store.ingestGroup).toHaveBeenNthCalledWith(1, [message]);
    expect(store.ingestGroup).toHaveBeenNthCalledWith(2, [message]);
  });
});
