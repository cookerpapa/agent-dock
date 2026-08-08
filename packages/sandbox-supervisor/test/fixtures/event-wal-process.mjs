import { WalEventSpoolStore } from "../../src/wal-event-spool.ts";

const rootDirectory = process.argv[2];
if (!rootDirectory) throw new Error("event WAL fixture requires a root directory");

const leaseId = "11111111-1111-4111-8111-111111111111";
const event = {
  protocolVersion: 1,
  messageId: "22222222-2222-4222-8222-222222222222",
  sentAt: "2026-08-08T08:00:00.000Z",
  type: "event.publish",
  payload: {
    leaseId,
    fencingToken: 7,
    commandId: "33333333-3333-4333-8333-333333333333",
    event: {
      schemaVersion: 1,
      eventId: "44444444-4444-4444-8444-444444444444",
      sessionId: "session-process-fault",
      turnId: "turn-process-fault",
      agentId: "root",
      seq: 1,
      occurredAt: "2026-08-08T08:00:00.000Z",
      type: "assistant.text.delta",
      payload: { text: "durable-before-worker-sigkill" },
    },
  },
};

const spool = await new WalEventSpoolStore({ rootDirectory }).open({
  sessionId: event.payload.event.sessionId,
  leaseId,
  fencingToken: 7,
  acknowledgedThroughSeq: 0,
  maxPendingEvents: 16,
  maxPendingBytes: 1_024 * 1_024,
});
await spool.append(event);
process.stdout.write(`${JSON.stringify({ status: "durable", sequence: 1 })}\n`);
setInterval(() => undefined, 60_000);
