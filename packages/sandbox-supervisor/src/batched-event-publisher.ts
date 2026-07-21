import {
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishBatchMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import type { SupervisorEventSpool } from "./in-memory-event-spool.ts";

export type SupervisorEventPublication = EventPublishMessage | EventPublishBatchMessage;

export type BatchedEventPublisherOptions = {
  publish(message: SupervisorEventPublication): Promise<EventAckMessage> | EventAckMessage;
  spool: SupervisorEventSpool;
  clock?: () => Date;
  idGenerator?: () => string;
  batchWindowMs?: number;
  maximumBatchEvents?: number;
  maximumBatchBytes?: number;
  maximumBufferedEvents?: number;
};

const DEFAULT_BATCH_WINDOW_MS = 20;
const DEFAULT_MAXIMUM_BATCH_EVENTS = 64;
const DEFAULT_MAXIMUM_BATCH_BYTES = 512 * 1_024;
const DEFAULT_MAXIMUM_BUFFERED_EVENTS = 512;

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a bounded integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Event publisher clock returned an invalid date");
  }
  return value;
}

/**
 * Decouples Pi's high-frequency event production from remote database ACKs.
 * Every event is already durable in the local spool before enqueue(), while
 * this publisher sends contiguous batches and applies one cumulative ACK.
 */
export class BatchedEventPublisher {
  readonly #publish: BatchedEventPublisherOptions["publish"];
  readonly #spool: SupervisorEventSpool;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #batchWindowMs: number;
  readonly #maximumBatchEvents: number;
  readonly #maximumBatchBytes: number;
  readonly #maximumBufferedEvents: number;
  readonly #queue: EventPublishMessage[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;
  #failure: Error | undefined;
  #draining = false;

  constructor(options: BatchedEventPublisherOptions) {
    this.#publish = options.publish;
    this.#spool = options.spool;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#batchWindowMs = boundedInteger(
      options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      "batchWindowMs",
      1,
      1_000,
    );
    this.#maximumBatchEvents = boundedInteger(
      options.maximumBatchEvents ?? DEFAULT_MAXIMUM_BATCH_EVENTS,
      "maximumBatchEvents",
      1,
      128,
    );
    this.#maximumBatchBytes = boundedInteger(
      options.maximumBatchBytes ?? DEFAULT_MAXIMUM_BATCH_BYTES,
      "maximumBatchBytes",
      1_024,
      900 * 1_024,
    );
    this.#maximumBufferedEvents = boundedInteger(
      options.maximumBufferedEvents ?? DEFAULT_MAXIMUM_BUFFERED_EVENTS,
      "maximumBufferedEvents",
      this.#maximumBatchEvents,
      8_192,
    );
  }

  async enqueue(message: EventPublishMessage): Promise<void> {
    this.#throwIfFailed();
    const previous = this.#queue.at(-1);
    if (
      previous !== undefined &&
      (previous.payload.event.sessionId !== message.payload.event.sessionId ||
        previous.payload.leaseId !== message.payload.leaseId ||
        previous.payload.fencingToken !== message.payload.fencingToken ||
        previous.payload.commandId !== message.payload.commandId ||
        message.payload.event.seq !== previous.payload.event.seq + 1)
    ) {
      throw new Error("Batched event publisher received a non-contiguous event");
    }
    this.#queue.push(message);
    if (this.#queue.length >= this.#maximumBufferedEvents) {
      await this.#flush(true);
      this.#throwIfFailed();
      return;
    }
    if (this.#queue.length >= this.#maximumBatchEvents) {
      void this.#flush(false);
      return;
    }
    this.#schedule();
  }

  async drain(): Promise<void> {
    this.#draining = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    try {
      while (this.#queue.length > 0 || this.#flushing !== undefined) {
        await this.#flush(true);
      }
      this.#throwIfFailed();
    } finally {
      this.#draining = false;
    }
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#flushing !== undefined || this.#draining) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush(false);
    }, this.#batchWindowMs);
    this.#timer.unref();
  }

  async #flush(wait: boolean): Promise<void> {
    this.#throwIfFailed();
    if (this.#flushing === undefined && this.#queue.length > 0) {
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      const batch = this.#takeBatch();
      this.#flushing = this.#publishBatch(batch)
        .catch((error: unknown) => {
          this.#failure = error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          this.#flushing = undefined;
          if (this.#failure === undefined && this.#queue.length > 0) {
            if (this.#draining || this.#queue.length >= this.#maximumBatchEvents) {
              void this.#flush(false).catch(() => undefined);
            } else {
              this.#schedule();
            }
          }
        });
    }
    if (wait && this.#flushing !== undefined) await this.#flushing;
    this.#throwIfFailed();
  }

  #takeBatch(): EventPublishMessage[] {
    const batch: EventPublishMessage[] = [];
    let bytes = 256;
    while (batch.length < this.#maximumBatchEvents && this.#queue.length > 0) {
      const next = this.#queue[0]!;
      const nextBytes = Buffer.byteLength(JSON.stringify(next.payload.event), "utf8") + 1;
      if (batch.length > 0 && bytes + nextBytes > this.#maximumBatchBytes) break;
      batch.push(this.#queue.shift()!);
      bytes += nextBytes;
    }
    return batch;
  }

  async #publishBatch(batch: readonly EventPublishMessage[]): Promise<void> {
    const first = batch[0];
    const last = batch.at(-1);
    if (first === undefined || last === undefined) return;
    const candidate = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: validDate(this.#clock).toISOString(),
      type: "event.publish_batch",
      payload: {
        leaseId: first.payload.leaseId,
        fencingToken: first.payload.fencingToken,
        ...(first.payload.commandId === undefined ? {} : { commandId: first.payload.commandId }),
        events: batch.map((message) => message.payload.event),
      },
    });
    if (candidate.type !== "event.publish_batch") {
      throw new Error("Batched event publication envelope was invalid");
    }
    const acknowledgement = await this.#publish(candidate);
    if (
      acknowledgement.payload.sessionId !== last.payload.event.sessionId ||
      acknowledgement.payload.leaseId !== last.payload.leaseId ||
      acknowledgement.payload.fencingToken !== last.payload.fencingToken ||
      acknowledgement.payload.acknowledgedThroughSeq !== last.payload.event.seq
    ) {
      throw new Error("Batched event acknowledgement identity did not match");
    }
    await this.#spool.acknowledge(acknowledgement);
  }

  #throwIfFailed(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }
}
