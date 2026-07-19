import type { AgentDockEvent } from "@agent-dock/protocol";
import type { OnApplicationShutdown } from "@nestjs/common";

export type SessionEventWake = {
  throughSequence: number | null;
};

type PendingRead = {
  resolve: (wake: SessionEventWake | undefined) => void;
};

export class SessionEventSubscription {
  readonly #sessionId: string;
  readonly #onClose: (subscription: SessionEventSubscription) => void;
  #queuedWake: SessionEventWake | undefined;
  #pendingRead: PendingRead | undefined;
  #closed = false;

  constructor(sessionId: string, onClose: (subscription: SessionEventSubscription) => void) {
    this.#sessionId = sessionId;
    this.#onClose = onClose;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  notifyThrough(throughSequence: number): void {
    if (this.#closed) return;
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
      throw new TypeError("throughSequence must be a positive safe integer");
    }
    this.#push({ throughSequence });
  }

  resync(): void {
    if (this.#closed) return;
    this.#push({ throughSequence: null });
  }

  #push(wake: SessionEventWake): void {
    if (this.#pendingRead !== undefined) {
      const pending = this.#pendingRead;
      this.#pendingRead = undefined;
      pending.resolve(wake);
      return;
    }
    if (this.#queuedWake === undefined) {
      this.#queuedWake = wake;
      return;
    }
    if (this.#queuedWake.throughSequence === null || wake.throughSequence === null) {
      this.#queuedWake = { throughSequence: null };
      return;
    }
    this.#queuedWake = {
      throughSequence: Math.max(this.#queuedWake.throughSequence, wake.throughSequence),
    };
  }

  next(): Promise<SessionEventWake | undefined> {
    if (this.#queuedWake !== undefined) {
      const wake = this.#queuedWake;
      this.#queuedWake = undefined;
      return Promise.resolve(wake);
    }
    if (this.#closed) return Promise.resolve(undefined);
    if (this.#pendingRead !== undefined) {
      throw new Error("Only one pending session-event read is allowed");
    }
    return new Promise<SessionEventWake | undefined>((resolve) => {
      this.#pendingRead = { resolve };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queuedWake = undefined;
    const pending = this.#pendingRead;
    this.#pendingRead = undefined;
    pending?.resolve(undefined);
    this.#onClose(this);
  }
}

export class SessionEventHub implements OnApplicationShutdown {
  readonly #subscriptions = new Map<string, Set<SessionEventSubscription>>();

  subscribe(sessionId: string): SessionEventSubscription {
    const subscription = new SessionEventSubscription(sessionId, (closed) => this.#remove(closed));
    const current = this.#subscriptions.get(sessionId);
    if (current === undefined) {
      this.#subscriptions.set(sessionId, new Set([subscription]));
    } else {
      current.add(subscription);
    }
    return subscription;
  }

  publish(event: AgentDockEvent): void {
    this.notifyThrough(event.sessionId, event.seq);
  }

  notifyThrough(sessionId: string, throughSequence: number): void {
    const current = this.#subscriptions.get(sessionId);
    if (current === undefined) return;
    for (const subscription of [...current]) subscription.notifyThrough(throughSequence);
  }

  resyncAll(): void {
    for (const current of this.#subscriptions.values()) {
      for (const subscription of [...current]) subscription.resync();
    }
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
