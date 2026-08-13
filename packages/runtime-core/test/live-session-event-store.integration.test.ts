import type { EventPublishMessage } from "@agent-dock/protocol";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LiveSessionEventStoreError,
  MemoryLiveSessionEventStore,
  ValkeyLiveSessionEventStore,
} from "../src/live-session-event-store.ts";

const IDS = {
  tenant: "71000000-0000-4000-8000-000000000001",
  session: "71000000-0000-4000-8000-000000000002",
  turn: "71000000-0000-4000-8000-000000000003",
  command: "71000000-0000-4000-8000-000000000004",
  lease: "71000000-0000-4000-8000-000000000005",
};

let root: string;
let port: number;
let store: ValkeyLiveSessionEventStore;

function publication(sequence: number, text: string, eventId: string): EventPublishMessage {
  return {
    protocolVersion: 1,
    messageId: `72000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sentAt: "2026-08-10T00:00:00.000Z",
    type: "event.publish",
    payload: {
      commandId: IDS.command,
      leaseId: IDS.lease,
      fencingToken: 1,
      event: {
        schemaVersion: 1,
        eventId,
        sessionId: IDS.session,
        turnId: IDS.turn,
        agentId: "root",
        seq: sequence,
        occurredAt: "2026-08-10T00:00:00.000Z",
        type: "assistant.text.delta",
        payload: { text },
      },
    },
  };
}

describe("in-memory live Session event store", () => {
  it("resets only a tenant-owned Session stream", async () => {
    const memory = new MemoryLiveSessionEventStore();
    const first = publication(1, "hello", "73000000-0000-4000-8000-000000000011");
    await memory.append({
      tenantId: IDS.tenant,
      sessionId: IDS.session,
      previousSequence: 0,
      messages: [first],
    });
    await expect(memory.resetSession("wrong-tenant", IDS.session)).rejects.toBeInstanceOf(
      LiveSessionEventStoreError,
    );
    await memory.resetSession(IDS.tenant, IDS.session);
    await expect(memory.readPage(IDS.tenant, IDS.session, 0, 1)).resolves.toEqual([]);
  });
});

describe.skipIf(!existsSync("/usr/bin/redis-server"))("Valkey live Session event store", () => {
  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), "agent-dock-valkey-test-"));
    port = 20_000 + Math.floor(Math.random() * 20_000);
    const server = spawn(
      "/usr/bin/redis-server",
      [
        "--bind",
        "127.0.0.1",
        "--port",
        String(port),
        "--save",
        "",
        "--appendonly",
        "yes",
        "--appendfsync",
        "always",
        "--dir",
        root,
        "--pidfile",
        resolve(root, "redis.pid"),
        "--daemonize",
        "yes",
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.once("exit", (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`redis-server exited ${String(code)}`)),
      );
    });
    store = new ValkeyLiveSessionEventStore({ url: `redis://127.0.0.1:${String(port)}` });
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await store.checkHealth();
        lastError = undefined;
        break;
      } catch (error: unknown) {
        lastError = error;
        await delay(20);
      }
    }
    if (lastError !== undefined) throw lastError;
  });

  afterAll(async () => {
    await store?.close();
    try {
      const pid = Number((await readFile(resolve(root, "redis.pid"), "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
    } catch {
      // The daemon may already have stopped.
    }
    await rm(root, { recursive: true, force: true });
  });

  it("appends a contiguous durable stream, deduplicates exact replay, and trims it", async () => {
    const first = publication(1, "hello ", "73000000-0000-4000-8000-000000000001");
    const second = publication(2, "Valkey", "73000000-0000-4000-8000-000000000002");
    await expect(
      store.append({
        tenantId: IDS.tenant,
        sessionId: IDS.session,
        previousSequence: 0,
        messages: [first, second],
      }),
    ).resolves.toBe(2);
    await expect(
      store.append({
        tenantId: IDS.tenant,
        sessionId: IDS.session,
        previousSequence: 0,
        messages: [first, second],
      }),
    ).resolves.toBe(2);
    await expect(store.readPage(IDS.tenant, IDS.session, 0, 2)).resolves.toMatchObject([
      { seq: 1, payload: { text: "hello " } },
      { seq: 2, payload: { text: "Valkey" } },
    ]);
    await expect(
      store.append({
        tenantId: IDS.tenant,
        sessionId: IDS.session,
        previousSequence: 2,
        messages: [publication(2, "conflict", "73000000-0000-4000-8000-000000000003")],
      }),
    ).rejects.toBeInstanceOf(LiveSessionEventStoreError);
    await store.trimThrough(IDS.tenant, IDS.session, 2);
    await expect(store.readPage(IDS.tenant, IDS.session, 0, 2)).resolves.toEqual([]);
    const third = publication(4, "after terminal gap", "73000000-0000-4000-8000-000000000004");
    await expect(
      store.append({
        tenantId: IDS.tenant,
        sessionId: IDS.session,
        previousSequence: 3,
        messages: [third],
      }),
    ).resolves.toBe(4);
    await store.resetSession(IDS.tenant, IDS.session);
    await expect(store.readPage(IDS.tenant, IDS.session, 0, 4)).resolves.toEqual([]);
    await expect(
      store.append({
        tenantId: IDS.tenant,
        sessionId: IDS.session,
        previousSequence: 3,
        messages: [third],
      }),
    ).resolves.toBe(4);
  });
});
