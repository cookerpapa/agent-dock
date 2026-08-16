import { parseSupervisorToControlMessage, type EventPublishMessage } from "@pi-cloud/protocol";

export type WorkerEventLogBatch = Readonly<{
  tenantId: string;
  messages: readonly EventPublishMessage[];
}>;

export type WorkerEventLogEnvelope = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  messages: readonly EventPublishMessage[];
}>;

export type WorkerEventLogPosition = Readonly<{
  consumerGroup: string;
  topic: string;
  partition: number;
  offset: string;
}>;

export function parseWorkerEventLogEnvelope(value: Buffer | string | null): WorkerEventLogEnvelope {
  if (value === null) throw new TypeError("Kafka Worker event envelope was empty");
  const parsed = JSON.parse(value.toString()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Kafka Worker event envelope was invalid");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.tenantId !== "string" ||
    candidate.tenantId.length < 1 ||
    candidate.tenantId.length > 64 ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length < 1 ||
    candidate.messages.length > 1_024
  ) {
    throw new TypeError("Kafka Worker event envelope was invalid");
  }
  const messages = candidate.messages.map((message) => {
    const publication = parseSupervisorToControlMessage(message);
    if (publication.type !== "event.publish") {
      throw new TypeError("Kafka Worker event envelope contained a non-event message");
    }
    return publication;
  });
  const sessionId = messages[0]!.payload.event.sessionId;
  if (messages.some((message) => message.payload.event.sessionId !== sessionId)) {
    throw new TypeError("Kafka Worker event envelope mixed Sessions");
  }
  return Object.freeze({
    schemaVersion: 1,
    tenantId: candidate.tenantId,
    messages: Object.freeze(messages),
  });
}
