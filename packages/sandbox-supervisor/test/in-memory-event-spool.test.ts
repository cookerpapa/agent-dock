import { createAgentDockEventFactory, type AgentDockEvent } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { EventSpoolError, InMemoryEventSpool } from "../src/index.ts";

const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LEASE_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "33333333-3333-4333-8333-333333333333";
const SENT_AT = "2026-07-18T08:00:00.000Z";

type PublishMessage = {
  protocolVersion: 1;
  messageId: string;
  sentAt: string;
  type: "event.publish";
  payload: {
    leaseId: string;
    fencingToken: number;
    commandId: string;
    event: AgentDockEvent;
  };
};

function createFixture(initialSequence = 0) {
  let eventNumber = 0;
  let messageNumber = 0;
  const eventFactory = createAgentDockEventFactory(
    { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
    {
      initialSequence,
      clock: () => new Date(SENT_AT),
      idGenerator: () => `${String(++eventNumber).padStart(8, "0")}-0000-4000-8000-000000000000`,
    },
  );

  const nextMessageId = () =>
    `${String(++messageNumber).padStart(8, "0")}-1111-4111-8111-111111111111`;

  return {
    nextPublish(text: string): PublishMessage {
      return {
        protocolVersion: 1,
        messageId: nextMessageId(),
        sentAt: SENT_AT,
        type: "event.publish",
        payload: {
          leaseId: LEASE_ID,
          fencingToken: 7,
          commandId: COMMAND_ID,
          event: eventFactory.next({
            type: "assistant.text.delta",
            payload: { text },
          }),
        },
      };
    },
    ack(sequence: number) {
      return {
        protocolVersion: 1,
        messageId: nextMessageId(),
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
    nextMessageId,
  };
}

function createSpool(overrides: Partial<ConstructorParameters<typeof InMemoryEventSpool>[0]> = {}) {
  return new InMemoryEventSpool({
    sessionId: "session-1",
    leaseId: LEASE_ID,
    fencingToken: 7,
    ...overrides,
  });
}

describe("InMemoryEventSpool", () => {
  it("applies cumulative ACKs and replays the remaining ordered suffix", () => {
    const fixture = createFixture();
    const spool = createSpool();
    const messages = [
      fixture.nextPublish("one"),
      fixture.nextPublish("two"),
      fixture.nextPublish("three"),
    ];

    expect(messages.map((message) => spool.append(message))).toEqual([
      "appended",
      "appended",
      "appended",
    ]);
    expect(spool.replayAfter(0)).toEqual(messages);

    expect(spool.acknowledge(fixture.ack(2))).toEqual({
      acknowledgedThroughSeq: 2,
      removedCount: 2,
      duplicate: false,
    });
    expect(spool.pendingCount).toBe(1);
    expect(spool.replayAfter(2)).toEqual([messages[2]]);

    expect(spool.acknowledge(fixture.ack(2))).toEqual({
      acknowledgedThroughSeq: 2,
      removedCount: 0,
      duplicate: true,
    });
    expect(spool.acknowledge(fixture.ack(3)).removedCount).toBe(1);
    expect(spool.pendingCount).toBe(0);
  });

  it("replays identical publications after a simulated disconnect", () => {
    const fixture = createFixture();
    const spool = createSpool();
    const first = fixture.nextPublish("one");
    const second = fixture.nextPublish("two");
    spool.append(first);
    spool.append(second);

    const replayed = spool.replayAfter(0);
    expect(replayed.map((message) => message.messageId)).toEqual([
      first.messageId,
      second.messageId,
    ]);

    spool.acknowledge(fixture.ack(2));
    expect(spool.replayAfter(2)).toEqual([]);
    expect(() => spool.replayAfter(0)).toThrow("events are retained only after ACK 2");
  });

  it("treats an identical pending publication as a duplicate and rejects conflicts or gaps", () => {
    const fixture = createFixture();
    const spool = createSpool();
    const first = fixture.nextPublish("one");
    spool.append(first);

    expect(
      spool.append({
        ...first,
        messageId: fixture.nextMessageId(),
      }),
    ).toBe("duplicate");
    expect(() =>
      spool.append({
        ...first,
        messageId: fixture.nextMessageId(),
        payload: {
          ...first.payload,
          event: {
            ...first.payload.event,
            payload: { text: "changed under the same event ID" },
          },
        },
      }),
    ).toThrow("Conflicting event publication at sequence 1");

    fixture.nextPublish("two is lost before append");
    const third = fixture.nextPublish("three");
    expect(() => spool.append(third)).toThrow("Expected contiguous sequence 2, received 3");
  });

  it("rejects stale assignments, wrong sessions, ACK regression, and ACK beyond publication", () => {
    const fixture = createFixture();
    const spool = createSpool();
    const first = fixture.nextPublish("one");
    const second = fixture.nextPublish("two");

    expect(() =>
      spool.append({
        ...first,
        payload: { ...first.payload, leaseId: OTHER_LEASE_ID },
      }),
    ).toThrow("Stale assignment");
    expect(() =>
      spool.append({
        ...first,
        payload: {
          ...first.payload,
          event: { ...first.payload.event, sessionId: "session-2" },
        },
      }),
    ).toThrow("does not match spool session");

    spool.append(first);
    spool.append(second);
    expect(() => spool.acknowledge(fixture.ack(3))).toThrow("exceeds highest published sequence 2");
    spool.acknowledge(fixture.ack(2));
    expect(() => spool.acknowledge(fixture.ack(1))).toThrow("ACK regression from 2 to 1");
    expect(() =>
      spool.acknowledge({
        ...fixture.ack(2),
        payload: { ...fixture.ack(2).payload, fencingToken: 8 },
      }),
    ).toThrow("Stale assignment");
  });

  it("bounds unacknowledged events and resumes after backpressure is relieved", () => {
    const fixture = createFixture();
    const spool = createSpool({ maxPendingEvents: 2 });
    const first = fixture.nextPublish("one");
    const second = fixture.nextPublish("two");
    const third = fixture.nextPublish("three");
    spool.append(first);
    spool.append(second);

    expect(() => spool.append(third)).toThrow("Event spool is full at 2");
    expect(spool.highestProducedSeq).toBe(2);

    spool.acknowledge(fixture.ack(1));
    expect(spool.append(third)).toBe("appended");
    expect(spool.highestProducedSeq).toBe(3);
  });

  it("validates its initial cursor and capacity", () => {
    expect(() => createSpool({ acknowledgedThroughSeq: -1 })).toThrow(EventSpoolError);
    expect(() => createSpool({ maxPendingEvents: 0 })).toThrow(EventSpoolError);
    expect(() => createSpool({ fencingToken: 0 })).toThrow(EventSpoolError);
  });
});
