import type {
  ConversationTurnTranscriptResource,
  PiCloudEvent,
  PiCloudEventBody,
} from "@pi-cloud/protocol";

type TerminalEventBody = Extract<PiCloudEventBody, { type: "turn.failed" | "turn.cancelled" }>;

export type PrepareTerminalTurnProjectionInput = Readonly<{
  tenantId: string;
  sessionId: string;
  turnId: string;
  commandId: string;
  agentId: string;
  body: TerminalEventBody;
  eventId: string;
  occurredAt: string;
}>;

export type PreparedTerminalTurnProjection = Readonly<{
  schemaVersion: 1;
  previousSequence: number;
  terminalEvent: PiCloudEvent;
  transcript: ConversationTurnTranscriptResource;
}>;

export interface TerminalTurnProjectionSource {
  prepare(input: PrepareTerminalTurnProjectionInput): Promise<PreparedTerminalTurnProjection>;
}

/** Development fallback; production injects the Accepted Kafka projection. */
export class UnavailableTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  async prepare(_input: PrepareTerminalTurnProjectionInput): Promise<never> {
    throw new Error("No accepted live prefix is available in development composition");
  }
}
