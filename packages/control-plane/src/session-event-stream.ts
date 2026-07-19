import type { AgentDockEvent } from "@agent-dock/protocol";
import type { ServerResponse } from "node:http";
import {
  DurableEventStore,
  DurableEventStoreError,
  type EventReplayWindow,
} from "./durable-event-store.ts";
import {
  SessionEventHub,
  type SessionEventSubscription,
  type SessionEventWake,
} from "./session-event-hub.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_REPLAY_PAGE_SIZE = 500;

export type SessionEventStreamOptions = {
  heartbeatIntervalMs?: number;
  replayPageSize?: number;
};

type StreamItem = { kind: "wake"; wake: SessionEventWake | undefined } | { kind: "heartbeat" };

type ReplayWriteResult = {
  lastSentSequence: number;
  eventsWritten: number;
  writable: boolean;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function eventFrame(event: AgentDockEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function writeChunk(response: ServerResponse, chunk: string): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return new Promise<boolean>((resolve) => {
    const settle = (writable: boolean): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      resolve(writable);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const onError = (): void => settle(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function nextWithHeartbeat(
  pendingWake: Promise<SessionEventWake | undefined>,
  heartbeatIntervalMs: number,
): Promise<StreamItem> {
  let timer: NodeJS.Timeout | undefined;
  const heartbeat = new Promise<StreamItem>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "heartbeat" }), heartbeatIntervalMs);
    timer.unref();
  });
  const result = await Promise.race<StreamItem>([
    pendingWake.then((wake) => ({ kind: "wake", wake })),
    heartbeat,
  ]);
  if (result.kind === "wake" && timer !== undefined) clearTimeout(timer);
  return result;
}

export class OpenSessionEventStream {
  readonly #store: DurableEventStore;
  readonly #subscription: SessionEventSubscription;
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #highWaterMark: number;
  readonly #initialEvents: readonly AgentDockEvent[];
  readonly #afterSequence: number;
  readonly #heartbeatIntervalMs: number;
  readonly #replayPageSize: number;

  constructor(options: {
    store: DurableEventStore;
    subscription: SessionEventSubscription;
    tenantId: string;
    sessionId: string;
    highWaterMark: number;
    initialEvents: readonly AgentDockEvent[];
    afterSequence: number;
    heartbeatIntervalMs: number;
    replayPageSize: number;
  }) {
    this.#store = options.store;
    this.#subscription = options.subscription;
    this.#tenantId = options.tenantId;
    this.#sessionId = options.sessionId;
    this.#highWaterMark = options.highWaterMark;
    this.#initialEvents = options.initialEvents;
    this.#afterSequence = options.afterSequence;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.#replayPageSize = options.replayPageSize;
  }

  async pipe(response: ServerResponse): Promise<void> {
    let lastSentSequence = this.#afterSequence;
    const close = (): void => this.#subscription.close();
    response.once("close", close);
    try {
      const initial = await this.#writeReplayWindow(response, lastSentSequence, {
        highWaterMark: this.#highWaterMark,
        events: this.#initialEvents,
      });
      if (!initial.writable) return;
      lastSentSequence = initial.lastSentSequence;

      let pendingWake = this.#subscription.next();
      while (!response.destroyed && !response.writableEnded) {
        const item = await nextWithHeartbeat(pendingWake, this.#heartbeatIntervalMs);
        if (item.kind === "heartbeat") {
          const recovered = await this.#readAndWriteCurrentSuffix(response, lastSentSequence, null);
          if (!recovered.writable) return;
          lastSentSequence = recovered.lastSentSequence;
          if (recovered.eventsWritten === 0) {
            if (!(await writeChunk(response, ": keepalive\n\n"))) return;
          }
          continue;
        }
        if (item.wake === undefined) return;
        pendingWake = this.#subscription.next();
        if (item.wake.throughSequence !== null && item.wake.throughSequence <= lastSentSequence) {
          continue;
        }
        const delivered = await this.#readAndWriteCurrentSuffix(
          response,
          lastSentSequence,
          item.wake.throughSequence,
        );
        if (!delivered.writable) return;
        lastSentSequence = delivered.lastSentSequence;
      }
    } finally {
      response.off("close", close);
      this.#subscription.close();
    }
  }

  async #readAndWriteCurrentSuffix(
    response: ServerResponse,
    lastSentSequence: number,
    minimumThroughSequence: number | null,
  ): Promise<ReplayWriteResult> {
    const replay = await this.#store.openReplayWindow(
      this.#tenantId,
      this.#sessionId,
      lastSentSequence,
      this.#replayPageSize,
    );
    if (minimumThroughSequence !== null && replay.highWaterMark < minimumThroughSequence) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "Session event notification is ahead of the durable event stream",
      );
    }
    return this.#writeReplayWindow(response, lastSentSequence, replay);
  }

  async #writeReplayWindow(
    response: ServerResponse,
    startingSequence: number,
    replay: EventReplayWindow,
  ): Promise<ReplayWriteResult> {
    let lastSentSequence = startingSequence;
    let eventsWritten = 0;
    let page = replay.events;
    while (lastSentSequence < replay.highWaterMark) {
      if (page.length === 0) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "Durable event replay contains a sequence gap",
        );
      }
      for (const event of page) {
        if (event.seq <= lastSentSequence) continue;
        if (event.seq !== lastSentSequence + 1) {
          throw new DurableEventStoreError(
            "event_store_invariant",
            "Durable event replay contains a sequence gap",
          );
        }
        if (!(await writeChunk(response, eventFrame(event)))) {
          return { lastSentSequence, eventsWritten, writable: false };
        }
        lastSentSequence = event.seq;
        eventsWritten += 1;
      }
      if (lastSentSequence >= replay.highWaterMark) break;
      page = await this.#store.readReplayPage(
        this.#tenantId,
        this.#sessionId,
        lastSentSequence,
        replay.highWaterMark,
        this.#replayPageSize,
      );
    }
    return { lastSentSequence, eventsWritten, writable: true };
  }
}

export class SessionEventStream {
  readonly #store: DurableEventStore;
  readonly #hub: SessionEventHub;
  readonly #heartbeatIntervalMs: number;
  readonly #replayPageSize: number;

  constructor(
    store: DurableEventStore,
    hub: SessionEventHub,
    options: SessionEventStreamOptions = {},
  ) {
    this.#store = store;
    this.#hub = hub;
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.#replayPageSize = positiveInteger(
      options.replayPageSize ?? DEFAULT_REPLAY_PAGE_SIZE,
      "replayPageSize",
    );
  }

  async open(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
  ): Promise<OpenSessionEventStream> {
    const subscription = this.#hub.subscribe(tenantId, sessionId);
    try {
      const replay = await this.#store.openReplayWindow(
        tenantId,
        sessionId,
        afterSequence,
        this.#replayPageSize,
      );
      return new OpenSessionEventStream({
        store: this.#store,
        subscription,
        tenantId,
        sessionId,
        highWaterMark: replay.highWaterMark,
        initialEvents: replay.events,
        afterSequence,
        heartbeatIntervalMs: this.#heartbeatIntervalMs,
        replayPageSize: this.#replayPageSize,
      });
    } catch (error: unknown) {
      subscription.close();
      throw error;
    }
  }
}
