import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { SessionEventHub } from "@pi-cloud/runtime-core/session-event-hub";
import type { SessionEventNotificationTransport } from "@pi-cloud/runtime-core/session-event-notifications";

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
        this.#hub.notifyThrough(
          notification.tenantId,
          notification.sessionId,
          notification.throughSequence,
        ),
      onResync: () => this.#hub.resyncAll(),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#transport.stop();
  }
}
