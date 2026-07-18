import { createAgentDockEventFactory } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { SessionEventHub } from "../src/index.ts";

function fixture() {
  let eventNumber = 0;
  return createAgentDockEventFactory(
    { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
    {
      clock: () => new Date("2026-07-18T08:00:00.000Z"),
      idGenerator: () => `${String(++eventNumber).padStart(8, "0")}-0000-4000-8000-000000000000`,
    },
  );
}

describe("SessionEventHub", () => {
  it("delivers committed events to all current subscribers", async () => {
    const hub = new SessionEventHub();
    const first = hub.subscribe("session-1");
    const second = hub.subscribe("session-1");
    const event = fixture().next({
      type: "assistant.text.delta",
      payload: { text: "hello" },
    });

    const pending = first.next();
    hub.publish(event);
    await expect(pending).resolves.toEqual(event);
    await expect(second.next()).resolves.toEqual(event);
    first.close();
    second.close();
  });

  it("isolates sessions and disconnects a subscriber that exceeds its bounded queue", async () => {
    const hub = new SessionEventHub({ maxQueuedEvents: 1 });
    const slow = hub.subscribe("session-1");
    const other = hub.subscribe("session-2");
    const factory = fixture();
    hub.publish(factory.next({ type: "assistant.text.delta", payload: { text: "one" } }));
    hub.publish(factory.next({ type: "assistant.text.delta", payload: { text: "two" } }));

    expect(slow.closed).toBe(true);
    await expect(slow.next()).resolves.toBeUndefined();
    expect(other.closed).toBe(false);
    hub.onApplicationShutdown();
    expect(other.closed).toBe(true);
  });
});
