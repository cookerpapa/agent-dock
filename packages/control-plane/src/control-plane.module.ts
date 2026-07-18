import { Module, type DynamicModule } from "@nestjs/common";
import { ControlPlaneController, CONTROL_PLANE_STORE } from "./control-plane.controller.ts";
import { ControlPlaneStore, type ControlPlaneStoreOptions } from "./control-plane-store.ts";
import { DurableEventStore } from "./durable-event-store.ts";
import { SessionEventHub } from "./session-event-hub.ts";
import { SessionEventStream } from "./session-event-stream.ts";

@Module({})
export class ControlPlaneModule {
  static register(options: ControlPlaneStoreOptions): DynamicModule {
    const eventHub = new SessionEventHub();
    const eventStore = new DurableEventStore({
      database: options.database,
      tenantId: options.tenantId,
      eventHub,
    });
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
          useValue: new SessionEventStream(eventStore, eventHub),
        },
      ],
      exports: [DurableEventStore, SessionEventHub, SessionEventStream],
    };
  }
}
