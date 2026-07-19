import type { AgentDockEvent } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { SseFrameParser, streamSessionEvents, type SessionStreamStatus } from "../src/sse.ts";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const TURN_ID = "20000000-0000-4000-8000-000000000001";

function event(sequence: number, text: string): AgentDockEvent {
  return {
    schemaVersion: 1,
    eventId: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    agentId: "root",
    seq: sequence,
    occurredAt: "2026-07-19T00:00:00.000Z",
    type: "assistant.text.delta",
    payload: { text },
  };
}

function frame(value: AgentDockEvent, id = String(value.seq)): string {
  return `id: ${id}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function eventStream(body: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const midpoint = Math.floor(body.length / 2);
        controller.enqueue(encoder.encode(body.slice(0, midpoint)));
        controller.enqueue(encoder.encode(body.slice(midpoint)));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

describe("SSE session client", () => {
  it("parses fragmented CRLF frames, comments, and multiline data", () => {
    const parser = new SseFrameParser();
    expect(parser.push(": heartbeat\r\n\r")).toEqual([]);
    expect(parser.push("\nid: 7\r\nevent: note\r\ndata: first\r\ndata: second\r\n\r\n")).toEqual([
      { id: "7", event: "note", data: "first\nsecond" },
    ]);
  });

  it("reconnects from the durable cursor and ignores replay duplicates", async () => {
    const controller = new AbortController();
    const first = event(1, "first");
    const second = event(2, "second");
    const cursors: string[] = [];
    const delivered: number[] = [];
    const statuses: SessionStreamStatus[] = [];
    let call = 0;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      cursors.push(new Headers(init?.headers).get("last-event-id") ?? "missing");
      call += 1;
      return call === 1
        ? eventStream(frame(first))
        : eventStream(`${frame(first)}${frame(second)}`);
    };

    const lastSequence = await streamSessionEvents({
      sessionId: SESSION_ID,
      afterSequence: 0,
      signal: controller.signal,
      retryDelayMs: 0,
      fetchImplementation,
      onEvent(value) {
        delivered.push(value.seq);
        if (value.seq === 2) controller.abort();
      },
      onStatus(status) {
        statuses.push(status);
      },
    });

    expect(lastSequence).toBe(2);
    expect(cursors).toEqual(["0", "1"]);
    expect(delivered).toEqual([1, 2]);
    expect(statuses.map((status) => status.phase)).toContain("reconnecting");
  });

  it("stops on a non-retryable frame identity violation", async () => {
    const statuses: SessionStreamStatus[] = [];
    let calls = 0;
    const lastSequence = await streamSessionEvents({
      sessionId: SESSION_ID,
      afterSequence: 0,
      signal: new AbortController().signal,
      retryDelayMs: 0,
      fetchImplementation: async () => {
        calls += 1;
        return eventStream(frame(event(1, "bad"), "9"));
      },
      onEvent() {
        throw new Error("invalid frame must not be delivered");
      },
      onStatus(status) {
        statuses.push(status);
      },
    });
    expect(lastSequence).toBe(0);
    expect(calls).toBe(1);
    expect(statuses.at(-1)).toMatchObject({
      phase: "failed",
      message: "SSE frame identity does not match its event",
    });
  });
});
