import { validateCheckpointObjectKey, type CheckpointObjectStore } from "./checkpoint-store.ts";

export type TtlCheckpointObjectStoreOptions = {
  objectStore: CheckpointObjectStore;
  ttlMs?: number;
  maximumEntries?: number;
  maximumBytes?: number;
  clock?: () => number;
  observe?: (event: TtlCheckpointObjectStoreEvent) => void;
};

export type TtlCheckpointObjectStoreEvent = {
  result: "hit" | "miss" | "coalesced" | "write" | "evicted" | "deleted";
  entries: number;
  bytes: number;
};

export type TtlCheckpointObjectStoreSnapshot = {
  entries: number;
  bytes: number;
  pending: number;
};

type CheckpointCacheEntry = {
  bytes: Uint8Array;
  expiresAt: number;
};

const DEFAULT_CHECKPOINT_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_CHECKPOINT_CACHE_MAXIMUM_ENTRIES = 512;
const DEFAULT_CHECKPOINT_CACHE_MAXIMUM_BYTES = 32 * 1_024 * 1_024;

function boundedCacheInteger(
  value: number,
  minimum: number,
  maximum: number,
  description: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${description} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

/**
 * A Worker-local, bounded cache for immutable checkpoint objects.
 *
 * PostgreSQL still resolves and rechecks the current checkpoint head on every
 * Run. This cache only avoids downloading an already-selected immutable
 * manifest, JSONL segment, or Workspace object from S3 again.
 */
export class TtlCheckpointObjectStore implements CheckpointObjectStore {
  readonly #objectStore: CheckpointObjectStore;
  readonly #ttlMs: number;
  readonly #maximumEntries: number;
  readonly #maximumBytes: number;
  readonly #clock: () => number;
  readonly #observe: ((event: TtlCheckpointObjectStoreEvent) => void) | undefined;
  readonly #entries = new Map<string, CheckpointCacheEntry>();
  readonly #pending = new Map<string, Promise<Uint8Array>>();
  #bytes = 0;

  constructor(options: TtlCheckpointObjectStoreOptions) {
    this.#objectStore = options.objectStore;
    this.#ttlMs = boundedCacheInteger(
      options.ttlMs ?? DEFAULT_CHECKPOINT_CACHE_TTL_MS,
      1_000,
      60 * 60_000,
      "Checkpoint cache TTL",
    );
    this.#maximumEntries = boundedCacheInteger(
      options.maximumEntries ?? DEFAULT_CHECKPOINT_CACHE_MAXIMUM_ENTRIES,
      1,
      16_384,
      "Checkpoint cache maximum entries",
    );
    this.#maximumBytes = boundedCacheInteger(
      options.maximumBytes ?? DEFAULT_CHECKPOINT_CACHE_MAXIMUM_BYTES,
      1_024,
      512 * 1_024 * 1_024,
      "Checkpoint cache maximum bytes",
    );
    this.#clock = options.clock ?? Date.now;
    this.#observe = options.observe;
  }

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    const key = validateCheckpointObjectKey(objectKey);
    await this.#objectStore.put(key, bytes);
    this.#insert(key, bytes, this.#now());
    this.#emit("write");
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const key = validateCheckpointObjectKey(objectKey);
    const now = this.#now();
    this.#evictExpired(now);
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      this.#emit("hit");
      return Uint8Array.from(cached.bytes);
    }

    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      this.#emit("coalesced");
      return Uint8Array.from(await pending);
    }

    this.#emit("miss");
    const load = this.#objectStore.get(key).then((bytes) => {
      this.#insert(key, bytes, this.#now());
      return bytes;
    });
    this.#pending.set(key, load);
    try {
      return Uint8Array.from(await load);
    } finally {
      if (this.#pending.get(key) === load) this.#pending.delete(key);
    }
  }

  async delete(objectKey: string): Promise<void> {
    const key = validateCheckpointObjectKey(objectKey);
    await this.#objectStore.delete(key);
    this.#remove(key);
    this.#emit("deleted");
  }

  snapshot(): TtlCheckpointObjectStoreSnapshot {
    this.#evictExpired(this.#now());
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      pending: this.#pending.size,
    };
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Checkpoint cache clock must return a non-negative integer");
    }
    return value;
  }

  #insert(key: string, bytes: Uint8Array, now: number): void {
    this.#remove(key);
    if (bytes.byteLength > this.#maximumBytes) return;
    const copy = Uint8Array.from(bytes);
    this.#entries.set(key, {
      bytes: copy,
      expiresAt: now + this.#ttlMs,
    });
    this.#bytes += copy.byteLength;
    while (this.#entries.size > this.#maximumEntries || this.#bytes > this.#maximumBytes) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#remove(oldest);
      this.#emit("evicted");
    }
  }

  #evictExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt > now) continue;
      this.#remove(key);
      this.#emit("evicted");
    }
  }

  #remove(key: string): void {
    const existing = this.#entries.get(key);
    if (existing === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= existing.bytes.byteLength;
  }

  #emit(result: TtlCheckpointObjectStoreEvent["result"]): void {
    this.#observe?.({
      result,
      entries: this.#entries.size,
      bytes: this.#bytes,
    });
  }
}
