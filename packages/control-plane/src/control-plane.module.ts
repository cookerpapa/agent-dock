import { Module, type DynamicModule } from "@nestjs/common";
import { ControlPlaneController } from "./control-plane.controller.ts";
import type { ControlPlaneStoreOptions } from "./control-plane-store.ts";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { DurableEventStore } from "./durable-event-store.ts";
import {
  PublicTenantRegistrationService,
  type PublicTenantRegistrationConfiguration,
} from "./public-tenant-registration.ts";
import { SessionEventHub } from "./session-event-hub.ts";
import { SessionEventNotificationBridge } from "./session-event-notification-bridge.ts";
import type { SessionEventNotificationTransport } from "./session-event-notifications.ts";
import { SessionEventStream, type SessionEventStreamOptions } from "./session-event-stream.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";
import type { TenantModelCredentialVault } from "./model-credential-runtime.ts";
import { TenantModelConfigurationService } from "./tenant-model-configuration.ts";

export type ControlPlaneModuleOptions = Omit<
  ControlPlaneStoreOptions,
  "tenantId" | "defaultModelProfileId"
> & {
  sessionEventNotifications?: SessionEventNotificationTransport;
  sessionEventStreamOptions?: SessionEventStreamOptions;
  eventRuntime?: ControlPlaneEventRuntime;
  staticRequestIdentity?: TenantRequestIdentity;
  publicRegistration?: PublicTenantRegistrationConfiguration;
  modelCredentialVault?: TenantModelCredentialVault;
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
          provide: ControlPlaneStoreFactory,
          useValue: new ControlPlaneStoreFactory({
            database: options.database,
            ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
          }),
        },
        {
          provide: PublicTenantRegistrationService,
          useValue: new PublicTenantRegistrationService({
            database: options.database,
            ...(options.publicRegistration ?? {
              enabled: false,
              maximumTenants: 2,
              tenantQuotas: {
                maximumProjects: 10,
                maximumSessions: 100,
                maximumUnsettledTurns: 10,
                maximumConcurrentTurns: 1,
              },
            }),
          }),
        },
        {
          provide: TenantRequestContext,
          useValue: new TenantRequestContext(options.staticRequestIdentity),
        },
        {
          provide: TenantModelConfigurationService,
          useValue: new TenantModelConfigurationService({
            database: options.database,
            ...(options.modelCredentialVault === undefined
              ? {}
              : { vault: options.modelCredentialVault }),
          }),
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
