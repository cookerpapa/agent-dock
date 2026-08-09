import { KafkaJS } from "@confluentinc/kafka-javascript";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  KafkaWorkerEventLog,
  KafkaWorkerEventProjector,
  type WorkerEventLogBatch,
  type WorkerEventLogEnvelope,
} from "@agent-dock/runtime-core/worker-event-log";

const { Kafka, logLevel } = KafkaJS;

const brokers = (process.env.AGENT_DOCK_KAFKA_BROKERS ?? "127.0.0.1:19092")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const sessionCount = Number(process.env.AGENT_DOCK_KAFKA_ACCEPTANCE_SESSIONS ?? "64");
const eventsPerBatch = Number(process.env.AGENT_DOCK_KAFKA_ACCEPTANCE_EVENTS_PER_BATCH ?? "16");
if (!Number.isSafeInteger(sessionCount) || sessionCount < 1 || sessionCount > 2_048) {
  throw new Error("AGENT_DOCK_KAFKA_ACCEPTANCE_SESSIONS is invalid");
}
if (!Number.isSafeInteger(eventsPerBatch) || eventsPerBatch < 1 || eventsPerBatch > 256) {
  throw new Error("AGENT_DOCK_KAFKA_ACCEPTANCE_EVENTS_PER_BATCH is invalid");
}

const topic = `agent-dock-worker-events-acceptance-${randomUUID()}`;
const kafka = new Kafka({
  kafkaJS: {
    brokers,
    clientId: "agent-dock-kafka-acceptance-admin",
    logLevel: logLevel.NOTHING,
  },
});
const admin = kafka.admin();
const tenantId = randomUUID();
const sessions = Array.from({ length: sessionCount }, () => randomUUID());
const observed = new Map<string, number[]>();
let resolveComplete!: () => void;
const complete = new Promise<void>((resolve) => {
  resolveComplete = resolve;
});

function batch(sessionId: string, firstSequence: number): WorkerEventLogBatch {
  const occurredAt = new Date().toISOString();
  const commandId = randomUUID();
  const leaseId = randomUUID();
  const turnId = randomUUID();
  return {
    tenantId,
    messages: Array.from({ length: eventsPerBatch }, (_, index) => ({
      protocolVersion: 1 as const,
      messageId: randomUUID(),
      sentAt: occurredAt,
      type: "event.publish" as const,
      payload: {
        commandId,
        leaseId,
        fencingToken: 1,
        event: {
          schemaVersion: 1 as const,
          eventId: randomUUID(),
          sessionId,
          turnId,
          agentId: "root",
          seq: firstSequence + index,
          occurredAt,
          type: "assistant.text.delta" as const,
          payload: { text: `s${String(firstSequence + index)} ` },
        },
      },
    })),
  };
}

const eventLog = new KafkaWorkerEventLog({
  brokers,
  clientId: "agent-dock-kafka-acceptance-producer",
  topic,
});
const projector = new KafkaWorkerEventProjector({
  brokers,
  clientId: "agent-dock-kafka-acceptance-projector",
  topic,
  groupId: `agent-dock-kafka-acceptance-${randomUUID()}`,
  partitionsConsumedConcurrently: 8,
  sink: {
    project(envelope: WorkerEventLogEnvelope) {
      const sessionId = envelope.messages[0]!.payload.event.sessionId;
      const ranges = observed.get(sessionId) ?? [];
      ranges.push(envelope.messages[0]!.payload.event.seq);
      observed.set(sessionId, ranges);
      if (
        observed.size === sessionCount &&
        [...observed.values()].every((value) => value.length === 2)
      ) {
        resolveComplete();
      }
      return Promise.resolve();
    },
  },
});

await admin.connect();
try {
  process.stderr.write("Kafka acceptance: creating topic\n");
  await admin.createTopics({
    topics: [{ topic, numPartitions: 16, replicationFactor: 1 }],
  });
  process.stderr.write("Kafka acceptance: starting projector\n");
  await projector.start();
  const startedAt = performance.now();
  process.stderr.write("Kafka acceptance: publishing envelopes\n");
  await eventLog.append(sessions.map((sessionId) => batch(sessionId, 1)));
  await eventLog.append(sessions.map((sessionId) => batch(sessionId, eventsPerBatch + 1)));
  process.stderr.write("Kafka acceptance: awaiting projection\n");
  await Promise.race([
    complete,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Kafka projection acceptance timed out")), 30_000),
    ),
  ]);
  const durationMs = performance.now() - startedAt;
  for (const sessionId of sessions) {
    const ranges = observed.get(sessionId);
    if (ranges?.[0] !== 1 || ranges[1] !== eventsPerBatch + 1) {
      throw new Error(`Kafka did not preserve Session order for ${sessionId}`);
    }
  }
  const logicalEvents = sessionCount * eventsPerBatch * 2;
  const report = {
    format: "agent-dock.kafka-worker-event-acceptance.v1",
    generatedAt: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    input: { sessionCount, eventsPerBatch, logicalEvents, partitions: 16 },
    result: {
      projectedEnvelopes: sessionCount * 2,
      projectedLogicalEvents: logicalEvents,
      durationMs: Number(durationMs.toFixed(2)),
      eventsPerSecond: Number(((logicalEvents * 1_000) / durationMs).toFixed(2)),
      sessionOrderViolations: 0,
    },
    scope: [
      "single local Kafka broker",
      "Kafka transport and Session-key ordering only",
      "not a Stage 2 capacity or broker-failover claim",
    ],
  };
  if (process.argv.includes("--report")) {
    await writeFile(
      "docs/reports/kafka-worker-event-acceptance-latest.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      "docs/reports/kafka-worker-event-acceptance-latest.md",
      `# Kafka Worker event acceptance\n\n- Sessions: ${sessionCount}\n- Logical events: ${logicalEvents}\n- Projected envelopes: ${sessionCount * 2}\n- Duration: ${durationMs.toFixed(2)} ms\n- Throughput: ${report.result.eventsPerSecond.toFixed(2)} logical events/s\n- Session-order violations: 0\n\nThis is a single-local-broker transport check, not a Stage 2 capacity or failover claim.\n`,
    );
  }
  process.stderr.write("Kafka acceptance: completed\n");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await projector.close().catch(() => undefined);
  await eventLog.close().catch(() => undefined);
  await admin.deleteTopics({ topics: [topic], timeout: 10_000 }).catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}
