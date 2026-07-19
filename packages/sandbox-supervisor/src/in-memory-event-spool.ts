import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { isDeepStrictEqual } from "node:util";

export type InMemoryEventSpoolOptions = {
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  acknowledgedThroughSeq?: number;
  maxPendingEvents?: number;
};

export type SupervisorEventSpool = {
  readonly sessionId: string;
  readonly acknowledgedThroughSeq: number;
  readonly highestProducedSeq: number;
  readonly pendingCount: number;
  append(value: unknown): EventSpoolAppendResult | Promise<EventSpoolAppendResult>;
  acknowledge(value: unknown): EventSpoolAckResult | Promise<EventSpoolAckResult>;
  replayAfter(sequence: number): readonly EventPublishMessage[];
};

export type SupervisorEventSpoolFactory = (
  options: InMemoryEventSpoolOptions,
) => SupervisorEventSpool | Promise<SupervisorEventSpool>;

export type SupervisorEventSpoolRecoveryResult = {
  scannedSpools: number;
  replayedSpools: number;
  replayedEvents: number;
};

export interface SupervisorEventSpoolRecovery {
  redeliverPending(
    publishEvent: (message: EventPublishMessage) => Promise<EventAckMessage> | EventAckMessage,
  ): Promise<SupervisorEventSpoolRecoveryResult>;
}

export type EventSpoolAppendResult = "appended" | "duplicate";

export type EventSpoolAckResult = {
  acknowledgedThroughSeq: number;
  removedCount: number;
  duplicate: boolean;
};

export class EventSpoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventSpoolError";
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new EventSpoolError(`${field} must not be empty`);
  }
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EventSpoolError(`${field} must be a non-negative safe integer`);
  }
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EventSpoolError(`${field} must be a positive safe integer`);
  }
}

/**
 * Executable reference for AgentDock's cumulative event ACK semantics.
 *
 * This implementation is deliberately in-memory and therefore not the final
 * crash-safe spool. It proves ordering, fencing, duplicate delivery, bounded
 * buffering, and replay behavior before the storage implementation is chosen.
 */
export class InMemoryEventSpool implements SupervisorEventSpool {
  readonly #sessionId: string;
  readonly #leaseId: string;
  readonly #fencingToken: number;
  readonly #maxPendingEvents: number;
  readonly #pending = new Map<number, EventPublishMessage>();
  #acknowledgedThroughSeq: number;
  #highestProducedSeq: number;

  constructor(options: InMemoryEventSpoolOptions) {
    requireNonEmpty(options.sessionId, "sessionId");
    requireNonEmpty(options.leaseId, "leaseId");
    requirePositiveSafeInteger(options.fencingToken, "fencingToken");

    const acknowledgedThroughSeq = options.acknowledgedThroughSeq ?? 0;
    const maxPendingEvents = options.maxPendingEvents ?? 10_000;
    requireNonNegativeSafeInteger(acknowledgedThroughSeq, "acknowledgedThroughSeq");
    requirePositiveSafeInteger(maxPendingEvents, "maxPendingEvents");

    this.#sessionId = options.sessionId;
    this.#leaseId = options.leaseId;
    this.#fencingToken = options.fencingToken;
    this.#acknowledgedThroughSeq = acknowledgedThroughSeq;
    this.#highestProducedSeq = acknowledgedThroughSeq;
    this.#maxPendingEvents = maxPendingEvents;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get acknowledgedThroughSeq(): number {
    return this.#acknowledgedThroughSeq;
  }

  get highestProducedSeq(): number {
    return this.#highestProducedSeq;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  append(value: unknown): EventSpoolAppendResult {
    const message = parseSupervisorToControlMessage(value);
    if (message.type !== "event.publish") {
      throw new EventSpoolError(`Expected event.publish, received ${message.type}`);
    }
    this.#assertPublishAssignment(message);

    const sequence = message.payload.event.seq;
    if (sequence <= this.#acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `Cannot append sequence ${sequence}; it is already acknowledged through ${this.#acknowledgedThroughSeq}`,
      );
    }

    const existing = this.#pending.get(sequence);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing.payload, message.payload)) {
        return "duplicate";
      }
      throw new EventSpoolError(`Conflicting event publication at sequence ${sequence}`);
    }

    const expectedSequence = this.#highestProducedSeq + 1;
    if (sequence !== expectedSequence) {
      throw new EventSpoolError(
        `Expected contiguous sequence ${expectedSequence}, received ${sequence}`,
      );
    }
    if (this.#pending.size >= this.#maxPendingEvents) {
      throw new EventSpoolError(
        `Event spool is full at ${this.#maxPendingEvents} unacknowledged events`,
      );
    }

    this.#pending.set(sequence, message);
    this.#highestProducedSeq = sequence;
    return "appended";
  }

  acknowledge(value: unknown): EventSpoolAckResult {
    const message = parseControlToSupervisorMessage(value);
    if (message.type !== "event.ack") {
      throw new EventSpoolError(`Expected event.ack, received ${message.type}`);
    }
    this.#assertAckAssignment(message);

    const throughSequence = message.payload.acknowledgedThroughSeq;
    if (throughSequence < this.#acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `ACK regression from ${this.#acknowledgedThroughSeq} to ${throughSequence}`,
      );
    }
    if (throughSequence === this.#acknowledgedThroughSeq) {
      return {
        acknowledgedThroughSeq: this.#acknowledgedThroughSeq,
        removedCount: 0,
        duplicate: true,
      };
    }
    if (throughSequence > this.#highestProducedSeq) {
      throw new EventSpoolError(
        `ACK ${throughSequence} exceeds highest published sequence ${this.#highestProducedSeq}`,
      );
    }

    const removableSequences = [...this.#pending.keys()].filter(
      (sequence) => sequence <= throughSequence,
    );
    const expectedRemovalCount = throughSequence - this.#acknowledgedThroughSeq;
    if (removableSequences.length !== expectedRemovalCount) {
      throw new EventSpoolError(
        `Cannot cumulatively ACK through ${throughSequence}; the local spool contains a sequence gap`,
      );
    }

    for (const sequence of removableSequences) {
      this.#pending.delete(sequence);
    }
    this.#acknowledgedThroughSeq = throughSequence;
    return {
      acknowledgedThroughSeq: throughSequence,
      removedCount: removableSequences.length,
      duplicate: false,
    };
  }

  replayAfter(sequence: number): readonly EventPublishMessage[] {
    requireNonNegativeSafeInteger(sequence, "replay sequence");
    if (sequence < this.#acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `Cannot replay after ${sequence}; events are retained only after ACK ${this.#acknowledgedThroughSeq}`,
      );
    }
    if (sequence > this.#highestProducedSeq) {
      throw new EventSpoolError(
        `Cannot replay after ${sequence}; highest published sequence is ${this.#highestProducedSeq}`,
      );
    }

    return [...this.#pending.entries()]
      .filter(([eventSequence]) => eventSequence > sequence)
      .sort(([left], [right]) => left - right)
      .map(([, message]) => message);
  }

  #assertPublishAssignment(message: EventPublishMessage): void {
    if (message.payload.event.sessionId !== this.#sessionId) {
      throw new EventSpoolError(
        `Event session ${message.payload.event.sessionId} does not match spool session ${this.#sessionId}`,
      );
    }
    this.#assertLease(message.payload.leaseId, message.payload.fencingToken);
  }

  #assertAckAssignment(message: EventAckMessage): void {
    if (message.payload.sessionId !== this.#sessionId) {
      throw new EventSpoolError(
        `ACK session ${message.payload.sessionId} does not match spool session ${this.#sessionId}`,
      );
    }
    this.#assertLease(message.payload.leaseId, message.payload.fencingToken);
  }

  #assertLease(leaseId: string, fencingToken: number): void {
    if (leaseId !== this.#leaseId || fencingToken !== this.#fencingToken) {
      throw new EventSpoolError(
        `Stale assignment: expected lease ${this.#leaseId} fence ${this.#fencingToken}, received lease ${leaseId} fence ${fencingToken}`,
      );
    }
  }
}
