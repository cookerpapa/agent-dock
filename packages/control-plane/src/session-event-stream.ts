import type { AgentDockEvent } from "@agent-dock/protocol";
import type { ServerResponse } from "node:http";
import { DurableEventStore, DurableEventStoreError } from "./durable-event-store.ts";
import { SessionEventHub, type SessionEventSubscription } from "./session-event-hub.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_REPLAY_PAGE_SIZE = 500;

export type SessionEventStreamOptions = {
  heartbeatIntervalMs?: number;
  replayPageSize?: number;
};

type StreamItem = { kind: "event"; event: AgentDockEvent | undefined } | { kind: "heartbeat" };

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
  pendingEvent: Promise<AgentDockEvent | undefined>,
  heartbeatIntervalMs: number,
): Promise<StreamItem> {
  let timer: NodeJS.Timeout | undefined;
  const heartbeat = new Promise<StreamItem>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "heartbeat" }), heartbeatIntervalMs);
    timer.unref();
  });
  const result = await Promise.race<StreamItem>([
    pendingEvent.then((event) => ({ kind: "event", event })),
    heartbeat,
  ]);
  if (result.kind === "event" && timer !== undefined) clearTimeout(timer);
  return result;
}

export class OpenSessionEventStream {
  readonly #store: DurableEventStore;
  readonly #subscription: SessionEventSubscription;
  readonly #sessionId: string;
  readonly #highWaterMark: number;
  readonly #initialEvents: readonly AgentDockEvent[];
  readonly #afterSequence: number;
  readonly #heartbeatIntervalMs: number;
  readonly #replayPageSize: number;

  constructor(options: {
    store: DurableEventStore;
    subscription: SessionEventSubscription;
    sessionId: string;
    highWaterMark: number;
    initialEvents: readonly AgentDockEvent[];
    afterSequence: number;
    heartbeatIntervalMs: number;
    replayPageSize: number;
  }) {
    this.#store = options.store;
    this.#subscription = options.subscription;
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
      let page = this.#initialEvents;
      while (lastSentSequence < this.#highWaterMark) {
        if (page.length === 0) {
          throw new DurableEventStoreError(
            "event_store_invariant",
            "Durable event replay contains a sequence gap",
          );
        }
        for (const event of page) {
          if (event.seq <= lastSentSequence) continue;
          if (!(await writeChunk(response, eventFrame(event)))) return;
          lastSentSequence = event.seq;
        }
        if (lastSentSequence >= this.#highWaterMark) break;
        page = await this.#store.readReplayPage(
          this.#sessionId,
          lastSentSequence,
          this.#highWaterMark,
          this.#replayPageSize,
        );
      }

      let pendingEvent = this.#subscription.next();
      while (!response.destroyed && !response.writableEnded) {
        const item = await nextWithHeartbeat(pendingEvent, this.#heartbeatIntervalMs);
        if (item.kind === "heartbeat") {
          if (!(await writeChunk(response, ": keepalive\n\n"))) return;
          continue;
        }
        if (item.event === undefined) return;
        pendingEvent = this.#subscription.next();
        if (item.event.seq <= lastSentSequence) continue;
        if (!(await writeChunk(response, eventFrame(item.event)))) return;
        lastSentSequence = item.event.seq;
      }
    } finally {
      response.off("close", close);
      this.#subscription.close();
    }
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

  async open(sessionId: string, afterSequence: number): Promise<OpenSessionEventStream> {
    const subscription = this.#hub.subscribe(sessionId);
    try {
      const replay = await this.#store.openReplayWindow(
        sessionId,
        afterSequence,
        this.#replayPageSize,
      );
      return new OpenSessionEventStream({
        store: this.#store,
        subscription,
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
