import { Module, type DynamicModule } from "@nestjs/common";
import type { GitHubGatewayClient } from "@agent-dock/github-gateway";
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
import { GitHubIntegrationService } from "./github-integration-service.ts";
import { ModelGovernanceService } from "./model-governance-service.ts";
import { OperationalInsightsService } from "./operational-insights-service.ts";
import {
  WorkspaceVersionService,
  type TrustedArtifactReader,
} from "./workspace-version-service.ts";
import { WebAuthenticationService } from "./web-authentication.ts";
import { ProjectEnvironmentService } from "./project-environment-service.ts";

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
  artifactReader?: TrustedArtifactReader;
  githubGateway?: GitHubGatewayClient;
  webAuthentication?: WebAuthenticationService;
  platformOperatorTenantId?: string;
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
    const workspaceVersions = new WorkspaceVersionService({
      database: options.database,
      ...(options.artifactReader === undefined ? {} : { artifactReader: options.artifactReader }),
      ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
    });
    return {
      module: ControlPlaneModule,
      controllers: [ControlPlaneController],
      providers: [
        {
          provide: ControlPlaneStoreFactory,
          useValue: new ControlPlaneStoreFactory({
            database: options.database,
            ...(options.environmentImageRevision === undefined
              ? {}
              : { environmentImageRevision: options.environmentImageRevision }),
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
          provide: WebAuthenticationService,
          useValue:
            options.webAuthentication ??
            new WebAuthenticationService({
              database: options.database,
              enabled: false,
              maximumTenants: 2,
              tenantQuotas: {
                maximumProjects: 10,
                maximumSessions: 100,
                maximumUnsettledTurns: 10,
                maximumConcurrentTurns: 1,
              },
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
            ...(options.platformOperatorTenantId === undefined
              ? {}
              : { platformOperatorTenantId: options.platformOperatorTenantId }),
          }),
        },
        {
          provide: ModelGovernanceService,
          useValue: new ModelGovernanceService({ database: options.database }),
        },
        {
          provide: OperationalInsightsService,
          useValue: new OperationalInsightsService({ database: options.database }),
        },
        {
          provide: WorkspaceVersionService,
          useValue: workspaceVersions,
        },
        {
          provide: ProjectEnvironmentService,
          useValue: new ProjectEnvironmentService({
            database: options.database,
            imageRevision: options.environmentImageRevision ?? "development",
            ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
          }),
        },
        {
          provide: GitHubIntegrationService,
          useValue: new GitHubIntegrationService({
            database: options.database,
            workspaceVersions,
            ...(options.githubGateway === undefined ? {} : { gateway: options.githubGateway }),
            ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
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
      exports: [
        DurableEventStore,
        SessionEventHub,
        SessionEventStream,
        WorkspaceVersionService,
        ProjectEnvironmentService,
        GitHubIntegrationService,
      ],
    };
  }
}
