import { parsePiCloudEvent, type EventPublishMessage, type PiCloudEvent } from "@pi-cloud/protocol";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import type {
  PrepareTerminalTurnProjectionInput,
  PreparedTerminalTurnProjection,
  TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

type BufferedTurn = { updatedAt: number; events: PiCloudEvent[] };

/**
 * Retains only broker-accepted events for Runs active in this Worker. It is a
 * normal failure/cancellation optimization; lost-Worker recovery uses the
 * Control Plane's Kafka projection instead.
 */
export class AcknowledgedTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #turns = new Map<string, BufferedTurn>();
  readonly #maximumTurns: number;
  readonly #ttlMs: number;

  constructor(options: { maximumTurns?: number; ttlMs?: number } = {}) {
    this.#maximumTurns = options.maximumTurns ?? 1_024;
    this.#ttlMs = options.ttlMs ?? 60 * 60_000;
  }

  append(publication: EventPublishMessage): void {
    const event = publication.payload.event;
    if (event.turnId === null) return;
    this.#prune();
    let turn = this.#turns.get(event.turnId);
    if (turn === undefined) {
      if (this.#turns.size >= this.#maximumTurns) {
        const oldest = this.#turns.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#turns.delete(oldest);
      }
      turn = { updatedAt: Date.now(), events: [] };
      this.#turns.set(event.turnId, turn);
    }
    const last = turn.events.at(-1);
    if (last !== undefined && event.seq <= last.seq) return;
    if (last !== undefined && event.seq !== last.seq + 1) {
      throw new Error("Acknowledged Worker event buffer contains a sequence gap");
    }
    turn.events.push(event);
    turn.updatedAt = Date.now();
  }

  async prepare(
    input: PrepareTerminalTurnProjectionInput,
  ): Promise<PreparedTerminalTurnProjection> {
    const events = this.#turns.get(input.turnId)?.events ?? [];
    if (events.length === 0) throw new Error("No acknowledged live prefix is available");
    const previousSequence = events.at(-1)?.seq ?? 0;
    const terminalEvent = parsePiCloudEvent({
      schemaVersion: 1,
      eventId: input.eventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      seq: previousSequence + 1,
      occurredAt: input.occurredAt,
      ...input.body,
    });
    return {
      schemaVersion: 1,
      previousSequence,
      terminalEvent,
      transcript: projectConversationTurnTranscript([...events, terminalEvent]),
    };
  }

  #prune(): void {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [turnId, turn] of this.#turns) {
      if (turn.updatedAt < cutoff) this.#turns.delete(turnId);
    }
  }
}
