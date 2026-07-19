import { Module, type DynamicModule } from "@nestjs/common";
import { ControlPlaneController, CONTROL_PLANE_STORE } from "./control-plane.controller.ts";
import { ControlPlaneStore, type ControlPlaneStoreOptions } from "./control-plane-store.ts";
import { DurableEventStore } from "./durable-event-store.ts";
import { SessionEventHub } from "./session-event-hub.ts";
import { SessionEventNotificationBridge } from "./session-event-notification-bridge.ts";
import type { SessionEventNotificationTransport } from "./session-event-notifications.ts";
import { SessionEventStream, type SessionEventStreamOptions } from "./session-event-stream.ts";

export type ControlPlaneModuleOptions = ControlPlaneStoreOptions & {
  sessionEventNotifications?: SessionEventNotificationTransport;
  sessionEventStreamOptions?: SessionEventStreamOptions;
  eventRuntime?: ControlPlaneEventRuntime;
};

export type ControlPlaneEventRuntime = {
  eventHub: SessionEventHub;
  eventStore: DurableEventStore;
};

@Module({})
export class ControlPlaneModule {
  static register(options: ControlPlaneModuleOptions): DynamicModule {
    const eventHub = options.eventRuntime?.eventHub ?? new SessionEventHub();
    const eventStore =
      options.eventRuntime?.eventStore ??
      new DurableEventStore({
        database: options.database,
        tenantId: options.tenantId,
        eventHub,
        ...(options.sessionEventNotifications === undefined
          ? {}
          : { eventNotificationPublisher: options.sessionEventNotifications }),
      });
    const notificationBridge =
      options.sessionEventNotifications === undefined
        ? undefined
        : new SessionEventNotificationBridge(options.sessionEventNotifications, eventHub);
    return {
      module: ControlPlaneModule,
      controllers: [ControlPlaneController],
      providers: [
        {
          provide: CONTROL_PLANE_STORE,
          useValue: new ControlPlaneStore(options),
        },
        { provide: SessionEventHub, useValue: eventHub },
        { provide: DurableEventStore, useValue: eventStore },
        {
          provide: SessionEventStream,
          useValue: new SessionEventStream(eventStore, eventHub, options.sessionEventStreamOptions),
        },
        ...(notificationBridge === undefined
          ? []
          : [
              {
                provide: SessionEventNotificationBridge,
                useValue: notificationBridge,
              },
            ]),
      ],
      exports: [DurableEventStore, SessionEventHub, SessionEventStream],
    };
  }
}
