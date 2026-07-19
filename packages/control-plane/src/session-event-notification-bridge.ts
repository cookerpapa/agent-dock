import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { SessionEventHub } from "./session-event-hub.ts";
import type { SessionEventNotificationTransport } from "./session-event-notifications.ts";

export class SessionEventNotificationBridge implements OnModuleInit, OnApplicationShutdown {
  readonly #transport: SessionEventNotificationTransport;
  readonly #hub: SessionEventHub;

  constructor(transport: SessionEventNotificationTransport, hub: SessionEventHub) {
    this.#transport = transport;
    this.#hub = hub;
  }

  async onModuleInit(): Promise<void> {
    await this.#transport.start({
      onNotification: (notification) =>
        this.#hub.notifyThrough(notification.sessionId, notification.throughSequence),
      onResync: () => this.#hub.resyncAll(),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#transport.stop();
  }
}
