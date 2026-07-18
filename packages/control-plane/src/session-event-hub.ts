import type { AgentDockEvent } from "@agent-dock/protocol";
import type { OnApplicationShutdown } from "@nestjs/common";

const DEFAULT_MAX_QUEUED_EVENTS = 256;

export type SessionEventHubOptions = {
  maxQueuedEvents?: number;
};

type PendingRead = {
  resolve: (event: AgentDockEvent | undefined) => void;
};

export class SessionEventSubscription {
  readonly #sessionId: string;
  readonly #maxQueuedEvents: number;
  readonly #onClose: (subscription: SessionEventSubscription) => void;
  readonly #queue: AgentDockEvent[] = [];
  #pendingRead: PendingRead | undefined;
  #closed = false;

  constructor(
    sessionId: string,
    maxQueuedEvents: number,
    onClose: (subscription: SessionEventSubscription) => void,
  ) {
    this.#sessionId = sessionId;
    this.#maxQueuedEvents = maxQueuedEvents;
    this.#onClose = onClose;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(event: AgentDockEvent): void {
    if (this.#closed) return;
    if (this.#pendingRead !== undefined) {
      const pending = this.#pendingRead;
      this.#pendingRead = undefined;
      pending.resolve(event);
      return;
    }
    if (this.#queue.length >= this.#maxQueuedEvents) {
      this.close();
      return;
    }
    this.#queue.push(event);
  }

  next(): Promise<AgentDockEvent | undefined> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift());
    if (this.#closed) return Promise.resolve(undefined);
    if (this.#pendingRead !== undefined) {
      throw new Error("Only one pending session-event read is allowed");
    }
    return new Promise<AgentDockEvent | undefined>((resolve) => {
      this.#pendingRead = { resolve };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    const pending = this.#pendingRead;
    this.#pendingRead = undefined;
    pending?.resolve(undefined);
    this.#onClose(this);
  }
}

export class SessionEventHub implements OnApplicationShutdown {
  readonly #maxQueuedEvents: number;
  readonly #subscriptions = new Map<string, Set<SessionEventSubscription>>();

  constructor(options: SessionEventHubOptions = {}) {
    const maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS;
    if (!Number.isSafeInteger(maxQueuedEvents) || maxQueuedEvents < 1) {
      throw new TypeError("maxQueuedEvents must be a positive safe integer");
    }
    this.#maxQueuedEvents = maxQueuedEvents;
  }

  subscribe(sessionId: string): SessionEventSubscription {
    const subscription = new SessionEventSubscription(sessionId, this.#maxQueuedEvents, (closed) =>
      this.#remove(closed),
    );
    const current = this.#subscriptions.get(sessionId);
    if (current === undefined) {
      this.#subscriptions.set(sessionId, new Set([subscription]));
    } else {
      current.add(subscription);
    }
    return subscription;
  }

  publish(event: AgentDockEvent): void {
    const current = this.#subscriptions.get(event.sessionId);
    if (current === undefined) return;
    for (const subscription of [...current]) subscription.push(event);
  }

  onApplicationShutdown(): void {
    const subscriptions = [...this.#subscriptions.values()].flatMap((current) => [...current]);
    for (const subscription of subscriptions) subscription.close();
    this.#subscriptions.clear();
  }

  #remove(subscription: SessionEventSubscription): void {
    const current = this.#subscriptions.get(subscription.sessionId);
    if (current === undefined) return;
    current.delete(subscription);
    if (current.size === 0) this.#subscriptions.delete(subscription.sessionId);
  }
}
