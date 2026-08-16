import { performance } from "node:perf_hooks";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createPiCloudEventFactory } from "../packages/protocol/src/index.ts";
import { WalEventSpoolStore } from "../packages/sandbox-supervisor/src/index.ts";

const eventCount = 500;
const root = await mkdtemp(resolve(tmpdir(), "pi-cloud-event-spool-benchmark-"));
const leaseId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const sentAt = "2026-07-30T00:00:00.000Z";
let eventNumber = 0;
let messageNumber = 0;
const events = createPiCloudEventFactory(
  { sessionId: "benchmark-session", turnId: "benchmark-turn", agentId: "root" },
  {
    clock: () => new Date(sentAt),
    idGenerator: () => `${String(++eventNumber).padStart(8, "0")}-0000-4000-8000-000000000000`,
  },
);
const messageId = () => `${String(++messageNumber).padStart(8, "0")}-1111-4111-8111-111111111111`;

try {
  const store = new WalEventSpoolStore({ rootDirectory: root });
  const spool = await store.open({
    sessionId: "benchmark-session",
    leaseId,
    fencingToken: 1,
    maxPendingEvents: eventCount,
    maxPendingBytes: 16 * 1_024 * 1_024,
  });
  const appendStartedAt = performance.now();
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    await spool.append({
      protocolVersion: 1,
      messageId: messageId(),
      sentAt,
      type: "event.publish",
      payload: {
        leaseId,
        fencingToken: 1,
        commandId,
        event: events.next({
          type: "assistant.text.delta",
          payload: { text: `token-${String(sequence).padStart(4, "0")}` },
        }),
      },
    });
  }
  const appendMs = performance.now() - appendStartedAt;
  const ackStartedAt = performance.now();
  await spool.acknowledge({
    protocolVersion: 1,
    messageId: messageId(),
    sentAt,
    type: "event.ack",
    payload: {
      sessionId: "benchmark-session",
      leaseId,
      fencingToken: 1,
      acknowledgedThroughSeq: eventCount,
    },
  });
  const ackMs = performance.now() - ackStartedAt;
  const rootEntries = await readdir(root, { recursive: true });
  process.stdout.write(
    `${JSON.stringify(
      {
        result: "passed",
        implementation: "append-only-wal",
        eventCount,
        appendMs: Number(appendMs.toFixed(3)),
        appendEventsPerSecond: Number(((eventCount * 1_000) / appendMs).toFixed(1)),
        cumulativeAckMs: Number(ackMs.toFixed(3)),
        filesystemEntriesAfterDrain: rootEntries.length,
        modelCalls: 0,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
