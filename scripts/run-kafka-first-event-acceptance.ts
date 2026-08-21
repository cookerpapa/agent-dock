import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  KafkaAcceptedAgentEventConsumer,
  KafkaAcceptedAgentEventProducer,
  type KafkaAcceptedAgentEventEnvelope,
} from "@pi-cloud/runtime-core/kafka-agent-event-log";
import type { EventPublishBatchMessage } from "@pi-cloud/protocol";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const { Kafka, logLevel } = KafkaJS;
const brokers = (process.env.PI_CLOUD_KAFKA_BROKERS ?? "127.0.0.1:19092").split(",");
const sessionCount = Number(process.env.PI_CLOUD_KAFKA_ACCEPTANCE_SESSIONS ?? "256");
const eventsPerEnvelope = Number(process.env.PI_CLOUD_KAFKA_ACCEPTANCE_EVENTS ?? "16");
if (!Number.isSafeInteger(sessionCount) || sessionCount < 2 || sessionCount > 4_096) {
  throw new Error("PI_CLOUD_KAFKA_ACCEPTANCE_SESSIONS is invalid");
}
if (!Number.isSafeInteger(eventsPerEnvelope) || eventsPerEnvelope < 1 || eventsPerEnvelope > 128) {
  throw new Error("PI_CLOUD_KAFKA_ACCEPTANCE_EVENTS is invalid");
}

const topic = `pi-cloud-kafka-first-acceptance-${randomUUID()}`;
const kafka = new Kafka({
  kafkaJS: {
    brokers,
    clientId: "pi-cloud-kafka-first-acceptance-admin",
    logLevel: logLevel.NOTHING,
  },
});
const admin = kafka.admin();
const sessions = Array.from({ length: sessionCount }, () => randomUUID());
const tenantId = randomUUID();
const observed = new Map<string, number[]>();
let resolveComplete!: () => void;
const complete = new Promise<void>((resolve) => {
  resolveComplete = resolve;
});

function envelope(sessionId: string, firstSequence: number): KafkaAcceptedAgentEventEnvelope {
  const occurredAt = new Date().toISOString();
  const publication: EventPublishBatchMessage = {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: occurredAt,
    type: "event.publish_batch",
    payload: {
      commandId: randomUUID(),
      runId: randomUUID(),
      attemptId: randomUUID(),
      leaseId: randomUUID(),
      fencingToken: 1,
      events: Array.from({ length: eventsPerEnvelope }, (_, index) => ({
        schemaVersion: 1 as const,
        eventId: randomUUID(),
        sessionId,
        turnId: randomUUID(),
        agentId: "root",
        seq: firstSequence + index,
        occurredAt,
        type: "assistant.text.delta" as const,
        payload: { text: `chunk-${String(firstSequence + index)} ` },
      })),
    },
  };
  return { schemaVersion: 1, tenantId, publications: [publication] };
}

const producer = new KafkaAcceptedAgentEventProducer({
  brokers,
  clientId: "pi-cloud-kafka-first-acceptance-producer",
  topic,
});
const consumer = new KafkaAcceptedAgentEventConsumer({
  brokers,
  clientId: "pi-cloud-kafka-first-acceptance-consumer",
  topic,
  groupId: `pi-cloud-kafka-first-acceptance-${randomUUID()}`,
  partitionsConsumedConcurrently: 8,
  onEnvelope: async (value) => {
    const publication = value.publications[0]!;
    const first =
      publication.type === "event.publish"
        ? publication.payload.event
        : publication.payload.events[0]!;
    const sequences = observed.get(first.sessionId) ?? [];
    sequences.push(first.seq);
    observed.set(first.sessionId, sequences);
    if (
      observed.size === sessionCount &&
      [...observed.values()].every((item) => item.length === 2)
    ) {
      resolveComplete();
    }
  },
});

await admin.connect();
try {
  await admin.createTopics({
    topics: [{ topic, numPartitions: 16, replicationFactor: 1 }],
  });
  await consumer.start();
  const startedAt = performance.now();
  await producer.appendGroup(sessions.map((sessionId) => envelope(sessionId, 1)));
  await producer.appendGroup(
    sessions.map((sessionId) => envelope(sessionId, eventsPerEnvelope + 1)),
  );
  await Promise.race([
    complete,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Kafka-first acceptance timed out")), 30_000),
    ),
  ]);
  const durationMs = performance.now() - startedAt;
  for (const sessionId of sessions) {
    const sequences = observed.get(sessionId);
    if (sequences?.[0] !== 1 || sequences[1] !== eventsPerEnvelope + 1) {
      throw new Error(`Kafka did not preserve Session order for ${sessionId}`);
    }
  }
  const logicalEvents = sessionCount * eventsPerEnvelope * 2;
  const report = {
    format: "pi-cloud.kafka-first-event-acceptance.v1",
    generatedAt: new Date().toISOString(),
    revision:
      process.env.PI_CLOUD_REVISION ??
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    topology: { brokers, partitions: 16, producerAcks: "all", idempotentProducer: true },
    input: { sessionCount, eventsPerEnvelope, logicalEvents, envelopes: sessionCount * 2 },
    result: {
      durationMs: Number(durationMs.toFixed(2)),
      eventsPerSecond: Number(((logicalEvents * 1_000) / durationMs).toFixed(2)),
      sessionOrderViolations: 0,
    },
    scope: [
      "Kafka transport, batching and Session-key ordering",
      "single local broker; not an HA broker-failover claim",
      "real model/Cube and PostgreSQL projection are measured by separate production checks",
    ],
  };
  if (process.argv.includes("--report")) {
    await writeFile(
      "docs/reports/kafka-first-event-acceptance-latest.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      "docs/reports/kafka-first-event-acceptance-latest.md",
      `# Kafka-first event acceptance\n\n- Sessions: ${sessionCount}\n- Logical events: ${logicalEvents}\n- Envelopes: ${sessionCount * 2}\n- Duration: ${durationMs.toFixed(2)} ms\n- Throughput: ${report.result.eventsPerSecond.toFixed(2)} logical events/s\n- Session-order violations: 0\n\nThis is a single-local-broker transport check; real model/Cube and PostgreSQL projection use separate gates.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await consumer.close().catch(() => undefined);
  await producer.close().catch(() => undefined);
  await admin.deleteTopics({ topics: [topic], timeout: 10_000 }).catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}
