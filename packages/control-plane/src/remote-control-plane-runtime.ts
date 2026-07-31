import type { Database } from "@agent-dock/database";
import type { SandboxAssignmentInventory } from "@agent-dock/sandbox-supervisor";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Kysely } from "kysely";

import {
  createControlPlaneApplication,
  type ControlPlaneApplicationOptions,
} from "./application.ts";
import { AssignmentReconciler } from "./assignment-reconciler.ts";
import { DurableEventStore } from "@agent-dock/runtime-core/durable-event-store";
import {
  SupervisorMaintenanceRuntime,
  type SupervisorMaintenanceRuntimeOptions,
} from "./supervisor-maintenance-runtime.ts";
import { SessionEventHub } from "@agent-dock/runtime-core/session-event-hub";
import {
  WorkerControlChannelRouter,
  type WorkerControlChannelRouterOptions,
} from "./worker-control-channel.ts";
import {
  SupervisorConnectionManager,
  type SupervisorBootIdentity,
  type SupervisorConnectionManagerOptions,
  type SupervisorOwnerBoundary,
} from "./supervisor-connection-manager.ts";
import {
  SupervisorWebSocketGateway,
  type SupervisorUpgradeAuthorizer,
  type SupervisorWebSocketGatewayOptions,
} from "./supervisor-websocket-gateway.ts";
import type { SupervisorProvisioningGateway } from "./supervisor-boot-provisioner.ts";
import type { ProductionHttpGateway } from "./production-http-gateway.ts";

type ConnectionManagerConfiguration = Omit<
  SupervisorConnectionManagerOptions,
  "database" | "controlPlaneInstanceId" | "ownerBoundary" | "assignmentRetirerFactory"
>;

type ControlChannelConfiguration = Omit<WorkerControlChannelRouterOptions, "eventIngestor">;

type GatewayConfiguration = Omit<
  SupervisorWebSocketGatewayOptions,
  "manager" | "authorizer" | "controlChannelRouter"
>;

type MaintenanceConfiguration = Omit<SupervisorMaintenanceRuntimeOptions, "maintenanceRunner">;

export type RemoteControlPlaneRuntimeOptions = Omit<
  ControlPlaneApplicationOptions,
  "supervisorWebSocketGateway" | "eventRuntime"
> & {
  database: Kysely<Database>;
  controlPlaneInstanceId: string;
  supervisorAuthorizer: SupervisorUpgradeAuthorizer;
  supervisorOwnerBoundary: SupervisorOwnerBoundary;
  assignmentInventoryFactory: (identity: SupervisorBootIdentity) => SandboxAssignmentInventory;
  supervisorProvisioningGateway?: SupervisorProvisioningGateway;
  productionHttpGateway?: ProductionHttpGateway;
  connectionManager?: ConnectionManagerConfiguration;
  controlChannelRouter?: ControlChannelConfiguration;
  gateway?: GatewayConfiguration;
  maintenance?: MaintenanceConfiguration;
};

export type RemoteControlPlaneRuntimeState = "ready" | "running" | "closing" | "closed";

export class RemoteControlPlaneRuntime {
  readonly application: NestFastifyApplication;
  readonly eventHub: SessionEventHub;
  readonly eventStore: DurableEventStore;
  readonly controlChannelRouter: WorkerControlChannelRouter;
  readonly connectionManager: SupervisorConnectionManager;
  readonly gateway: SupervisorWebSocketGateway;
  readonly maintenance: SupervisorMaintenanceRuntime;
  #state: RemoteControlPlaneRuntimeState = "ready";
  #closing: Promise<void> | undefined;

  constructor(options: {
    application: NestFastifyApplication;
    eventHub: SessionEventHub;
    eventStore: DurableEventStore;
    controlChannelRouter: WorkerControlChannelRouter;
    connectionManager: SupervisorConnectionManager;
    gateway: SupervisorWebSocketGateway;
    maintenance: SupervisorMaintenanceRuntime;
  }) {
    this.application = options.application;
    this.eventHub = options.eventHub;
    this.eventStore = options.eventStore;
    this.controlChannelRouter = options.controlChannelRouter;
    this.connectionManager = options.connectionManager;
    this.gateway = options.gateway;
    this.maintenance = options.maintenance;
  }

  get state(): RemoteControlPlaneRuntimeState {
    return this.#state;
  }

  async listen(port: number, host: string): Promise<string> {
    if (this.#state !== "ready") {
      throw new Error("Remote control-plane runtime can only listen once");
    }
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new TypeError("runtime port must be an integer between 0 and 65535");
    }
    if (host.trim().length === 0) throw new TypeError("runtime host must not be empty");
    try {
      await this.application.listen(port, host);
      this.maintenance.start();
      this.#state = "running";
      return this.application.getUrl();
    } catch (error: unknown) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    this.maintenance.beginDrain();
    this.gateway.shutdown();
    try {
      await this.maintenance.stop();
    } finally {
      try {
        await this.application.close();
      } finally {
        this.#state = "closed";
      }
    }
  }
}

export async function createRemoteControlPlaneRuntime(
  options: RemoteControlPlaneRuntimeOptions,
): Promise<RemoteControlPlaneRuntime> {
  const eventHub = new SessionEventHub();
  const eventStore = new DurableEventStore({
    database: options.database,
    eventHub,
    ...(options.sessionEventNotifications === undefined
      ? {}
      : { eventNotificationPublisher: options.sessionEventNotifications }),
  });
  const controlChannelRouter = new WorkerControlChannelRouter({
    ...options.controlChannelRouter,
    eventIngestor: eventStore,
  });
  const connectionManager = new SupervisorConnectionManager({
    ...options.connectionManager,
    database: options.database,
    controlPlaneInstanceId: options.controlPlaneInstanceId,
    ownerBoundary: options.supervisorOwnerBoundary,
    assignmentRetirerFactory: (identity) =>
      new AssignmentReconciler({
        database: options.database,
        sandboxId: identity.sandboxId,
        inventory: options.assignmentInventoryFactory(identity),
        ...(options.sessionEventNotifications === undefined
          ? {}
          : { eventNotificationPublisher: options.sessionEventNotifications }),
      }),
  });
  const gateway = new SupervisorWebSocketGateway({
    ...options.gateway,
    manager: connectionManager,
    authorizer: options.supervisorAuthorizer,
    controlChannelRouter,
  });
  const maintenance = new SupervisorMaintenanceRuntime({
    ...options.maintenance,
    maintenanceRunner: connectionManager,
  });

  let application: NestFastifyApplication | undefined;
  try {
    application = await createControlPlaneApplication({
      database: options.database,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      ...(options.defaultModelProfileId === undefined
        ? {}
        : { defaultModelProfileId: options.defaultModelProfileId }),
      ...(options.environmentImageRevision === undefined
        ? {}
        : { environmentImageRevision: options.environmentImageRevision }),
      ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
      supervisorWebSocketGateway: gateway,
      ...(options.supervisorProvisioningGateway === undefined
        ? {}
        : { supervisorProvisioningGateway: options.supervisorProvisioningGateway }),
      ...(options.productionHttpGateway === undefined
        ? {}
        : { productionHttpGateway: options.productionHttpGateway }),
      ...(options.publicRegistration === undefined
        ? {}
        : { publicRegistration: options.publicRegistration }),
      ...(options.webAuthentication === undefined
        ? {}
        : { webAuthentication: options.webAuthentication }),
      ...(options.modelCredentialVault === undefined
        ? {}
        : { modelCredentialVault: options.modelCredentialVault }),
      ...(options.platformOperatorTenantId === undefined
        ? {}
        : { platformOperatorTenantId: options.platformOperatorTenantId }),
      ...(options.platformModelSourceTenantId === undefined
        ? {}
        : { platformModelSourceTenantId: options.platformModelSourceTenantId }),
      ...(options.cubeEgressConfigToken === undefined
        ? {}
        : { cubeEgressConfigToken: options.cubeEgressConfigToken }),
      eventRuntime: { eventHub, eventStore },
      ...(options.sessionEventNotifications === undefined
        ? {}
        : { sessionEventNotifications: options.sessionEventNotifications }),
      ...(options.sessionEventStreamOptions === undefined
        ? {}
        : { sessionEventStreamOptions: options.sessionEventStreamOptions }),
      ...(options.artifactReader === undefined ? {} : { artifactReader: options.artifactReader }),
      ...(options.providerSnapshotReader === undefined
        ? {}
        : { providerSnapshotReader: options.providerSnapshotReader }),
      ...(options.advancedModulesEnabled === undefined
        ? {}
        : { advancedModulesEnabled: options.advancedModulesEnabled }),
    });
  } catch (error: unknown) {
    gateway.shutdown();
    await options.sessionEventNotifications?.stop().catch(() => undefined);
    throw error;
  }
  return new RemoteControlPlaneRuntime({
    application,
    eventHub,
    eventStore,
    controlChannelRouter,
    connectionManager,
    gateway,
    maintenance,
  });
}
