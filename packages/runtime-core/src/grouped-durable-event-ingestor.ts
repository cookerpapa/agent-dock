import { parseSupervisorToControlMessage, type EventAckMessage } from "@agent-dock/protocol";
import type { DurableEventGroupIngestor, DurableEventIngestor } from "./durable-event-store.ts";

type PendingPublication = {
  value: unknown;
  resolve: (acknowledgement: EventAckMessage) => void;
  reject: (error: unknown) => void;
};

type IngestShard = {
  queue: PendingPublication[];
  drainPromise: Promise<void> | undefined;
  timer: NodeJS.Timeout | undefined;
};

export type GroupedDurableEventIngestorOptions = {
  store: DurableEventGroupIngestor;
  shardCount?: number;
  maximumGroupSize?: number;
  maximumDelayMs?: number;
  maximumQueuedPublications?: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function shardHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Groups independent Session event batches behind one durable-store call while
 * retaining a stable shard per Session. This becomes one PostgreSQL commit in
 * local mode or one authenticated HTTP/Kafka append group in enterprise mode.
 * Acknowledgements are emitted only after the selected durable boundary, so
 * browser-visible events keep their "durable before visible" contract.
 */
export class GroupedDurableEventIngestor implements DurableEventIngestor {
  readonly #store: DurableEventGroupIngestor;
  readonly #shards: IngestShard[];
  readonly #maximumGroupSize: number;
  readonly #maximumDelayMs: number;
  readonly #maximumQueuedPublications: number;
  #queuedPublications = 0;

  constructor(options: GroupedDurableEventIngestorOptions) {
    this.#store = options.store;
    const shardCount = positiveInteger(options.shardCount ?? 8, "shardCount");
    this.#maximumGroupSize = positiveInteger(options.maximumGroupSize ?? 64, "maximumGroupSize");
    this.#maximumDelayMs = positiveInteger(options.maximumDelayMs ?? 4, "maximumDelayMs");
    this.#maximumQueuedPublications = positiveInteger(
      options.maximumQueuedPublications ?? 16_384,
      "maximumQueuedPublications",
    );
    this.#shards = Array.from({ length: shardCount }, () => ({
      queue: [],
      drainPromise: undefined,
      timer: undefined,
    }));
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    const message = parseSupervisorToControlMessage(value);
    if (message.type !== "event.publish" && message.type !== "event.publish_batch") {
      throw new TypeError("Grouped event ingestor accepts only event publications");
    }
    const sessionId =
      message.type === "event.publish"
        ? message.payload.event.sessionId
        : message.payload.events[0]!.sessionId;
    if (this.#queuedPublications >= this.#maximumQueuedPublications) {
      throw new Error("Durable event group-commit queue is full");
    }
    const shard = this.#shards[shardHash(sessionId) % this.#shards.length]!;
    this.#queuedPublications += 1;
    return new Promise<EventAckMessage>((resolve, reject) => {
      shard.queue.push({ value: message, resolve, reject });
      if (shard.queue.length >= this.#maximumGroupSize) {
        this.#clearTimer(shard);
        void this.#drain(shard);
      } else if (shard.timer === undefined && shard.drainPromise === undefined) {
        shard.timer = setTimeout(() => {
          shard.timer = undefined;
          void this.#drain(shard);
        }, this.#maximumDelayMs);
        shard.timer.unref();
      }
    });
  }

  async flush(): Promise<void> {
    await Promise.all(this.#shards.map((shard) => this.#drain(shard)));
  }

  #clearTimer(shard: IngestShard): void {
    if (shard.timer !== undefined) clearTimeout(shard.timer);
    shard.timer = undefined;
  }

  async #drain(shard: IngestShard): Promise<void> {
    if (shard.drainPromise !== undefined) return shard.drainPromise;
    this.#clearTimer(shard);
    const operation = this.#drainOwned(shard).finally(() => {
      shard.drainPromise = undefined;
      if (shard.queue.length > 0 && shard.timer === undefined) {
        shard.timer = setTimeout(() => {
          shard.timer = undefined;
          void this.#drain(shard);
        }, this.#maximumDelayMs);
        shard.timer.unref();
      }
    });
    shard.drainPromise = operation;
    return operation;
  }

  async #drainOwned(shard: IngestShard): Promise<void> {
    try {
      while (shard.queue.length > 0) {
        const group = shard.queue.splice(0, this.#maximumGroupSize);
        this.#queuedPublications -= group.length;
        try {
          const acknowledgements = await this.#store.ingestGroup(
            group.map((publication) => publication.value),
          );
          if (acknowledgements.length !== group.length) {
            throw new Error("Grouped event commit returned an incomplete acknowledgement set");
          }
          for (const [index, publication] of group.entries()) {
            publication.resolve(acknowledgements[index]!);
          }
        } catch (error: unknown) {
          const retryable =
            typeof error === "object" &&
            error !== null &&
            "retryable" in error &&
            (error as { retryable?: unknown }).retryable === true;
          if (retryable) {
            for (const publication of group) publication.reject(error);
            continue;
          }
          // A single invalid Session must not poison unrelated Session streams.
          // The grouped transaction is atomic, so retrying each durable event
          // publication independently cannot duplicate a partial group commit.
          if (group.length === 1) {
            group[0]!.reject(error);
            continue;
          }
          await Promise.all(
            group.map(async (publication) => {
              try {
                publication.resolve(await this.#store.ingest(publication.value));
              } catch (individualError: unknown) {
                publication.reject(individualError);
              }
            }),
          );
        }
      }
    } finally {
      this.#clearTimer(shard);
    }
  }
}
