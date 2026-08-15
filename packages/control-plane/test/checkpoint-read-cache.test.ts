import { describe, expect, it } from "vitest";
import {
  TtlCheckpointObjectStore,
  type CheckpointObjectStore,
  type TtlCheckpointObjectStoreEvent,
} from "../src/index.ts";

class CountingObjectStore implements CheckpointObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly gets = new Map<string, number>();
  gate: Promise<void> | undefined;

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(objectKey, Uint8Array.from(bytes));
  }

  async get(objectKey: string): Promise<Uint8Array> {
    this.gets.set(objectKey, (this.gets.get(objectKey) ?? 0) + 1);
    await this.gate;
    const bytes = this.objects.get(objectKey);
    if (bytes === undefined) throw new Error("missing object");
    return Uint8Array.from(bytes);
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}

describe("Worker-local immutable checkpoint read cache", () => {
  it("reuses immutable bytes for ten minutes without sharing mutable buffers", async () => {
    let now = 1_000;
    const objectStore = new CountingObjectStore();
    objectStore.objects.set("workspace/checkpoint.bin", Uint8Array.from([1, 2, 3]));
    const events: TtlCheckpointObjectStoreEvent[] = [];
    const cache = new TtlCheckpointObjectStore({
      objectStore,
      ttlMs: 600_000,
      clock: () => now,
      observe: (event) => events.push(event),
    });

    const first = await cache.get("workspace/checkpoint.bin");
    first[0] = 99;
    const second = await cache.get("workspace/checkpoint.bin");

    expect([...second]).toEqual([1, 2, 3]);
    expect(objectStore.gets.get("workspace/checkpoint.bin")).toBe(1);
    expect(cache.snapshot()).toEqual({ entries: 1, bytes: 3, pending: 0 });
    expect(events.map((event) => event.result)).toEqual(["miss", "hit"]);

    now += 600_001;
    await expect(cache.get("workspace/checkpoint.bin")).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    );
    expect(objectStore.gets.get("workspace/checkpoint.bin")).toBe(2);
    expect(events.map((event) => event.result)).toEqual(["miss", "hit", "evicted", "miss"]);
  });

  it("coalesces concurrent misses into one object-store request", async () => {
    const objectStore = new CountingObjectStore();
    objectStore.objects.set("pi/session/reference.json", Uint8Array.from([4, 5, 6]));
    let release!: () => void;
    objectStore.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const results: string[] = [];
    const cache = new TtlCheckpointObjectStore({
      objectStore,
      observe: (event) => results.push(event.result),
    });

    const first = cache.get("pi/session/reference.json");
    const second = cache.get("pi/session/reference.json");
    await Promise.resolve();
    expect(objectStore.gets.get("pi/session/reference.json")).toBe(1);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      Uint8Array.from([4, 5, 6]),
      Uint8Array.from([4, 5, 6]),
    ]);
    expect(results).toEqual(["miss", "coalesced"]);
  });

  it("bounds memory with LRU eviction and invalidates deleted objects", async () => {
    const objectStore = new CountingObjectStore();
    objectStore.objects.set("objects/one", new Uint8Array(512).fill(1));
    objectStore.objects.set("objects/two", new Uint8Array(512).fill(2));
    objectStore.objects.set("objects/three", new Uint8Array(512).fill(3));
    const cache = new TtlCheckpointObjectStore({
      objectStore,
      maximumEntries: 2,
      maximumBytes: 1_024,
    });

    await cache.get("objects/one");
    await cache.get("objects/two");
    await cache.get("objects/one");
    await cache.get("objects/three");
    expect(cache.snapshot()).toEqual({ entries: 2, bytes: 1_024, pending: 0 });

    await cache.get("objects/two");
    expect(objectStore.gets.get("objects/two")).toBe(2);
    await cache.delete("objects/two");
    expect(cache.snapshot()).toEqual({ entries: 1, bytes: 512, pending: 0 });
    await expect(cache.get("objects/two")).rejects.toThrow("missing object");
  });
});
