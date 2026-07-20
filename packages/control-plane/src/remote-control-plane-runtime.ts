import type { Database } from "@agent-dock/database";
import type { SandboxAssignmentInventory } from "@agent-dock/sandbox-supervisor";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Kysely } from "kysely";

import {
  createControlPlaneApplication,
  type ControlPlaneApplicationOptions,
} from "./application.ts";
import { AssignmentReconciler } from "./assignment-reconciler.ts";
import { DurableEventStore } from "./durable-event-store.ts";
import {
  RemoteSupervisorWorkerRuntime,
  type RemoteSupervisorWorkerRuntimeOptions,
} from "./remote-supervisor-worker-runtime.ts";
import { SessionEventHub } from "./session-event-hub.ts";
import {
  SupervisorCommandRouter,
  type SupervisorCommandRouterOptions,
} from "./supervisor-command-router.ts";
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

type CommandRouterConfiguration = Omit<SupervisorCommandRouterOptions, "eventIngestor">;

type GatewayConfiguration = Omit<
  SupervisorWebSocketGatewayOptions,
  "manager" | "authorizer" | "commandRouter"
>;

type WorkerConfiguration = Omit<
  RemoteSupervisorWorkerRuntimeOptions,
  "database" | "bindingSource" | "maintenanceRunner"
>;

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
  commandRouter?: CommandRouterConfiguration;
  gateway?: GatewayConfiguration;
  worker?: WorkerConfiguration;
};

export type RemoteControlPlaneRuntimeState = "ready" | "running" | "closing" | "closed";

export class RemoteControlPlaneRuntime {
  readonly application: NestFastifyApplication;
  readonly eventHub: SessionEventHub;
  readonly eventStore: DurableEventStore;
  readonly commandRouter: SupervisorCommandRouter;
  readonly connectionManager: SupervisorConnectionManager;
  readonly gateway: SupervisorWebSocketGateway;
  readonly worker: RemoteSupervisorWorkerRuntime;
  #state: RemoteControlPlaneRuntimeState = "ready";
  #closing: Promise<void> | undefined;

  constructor(options: {
    application: NestFastifyApplication;
    eventHub: SessionEventHub;
    eventStore: DurableEventStore;
    commandRouter: SupervisorCommandRouter;
    connectionManager: SupervisorConnectionManager;
    gateway: SupervisorWebSocketGateway;
    worker: RemoteSupervisorWorkerRuntime;
  }) {
    this.application = options.application;
    this.eventHub = options.eventHub;
    this.eventStore = options.eventStore;
    this.commandRouter = options.commandRouter;
    this.connectionManager = options.connectionManager;
    this.gateway = options.gateway;
    this.worker = options.worker;
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
      this.worker.start();
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
    this.worker.beginDrain();
    this.gateway.shutdown();
    try {
      await this.worker.stop();
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
  const commandRouter = new SupervisorCommandRouter({
    ...options.commandRouter,
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
      }),
  });
  const gateway = new SupervisorWebSocketGateway({
    ...options.gateway,
    manager: connectionManager,
    authorizer: options.supervisorAuthorizer,
    commandRouter,
  });
  const worker = new RemoteSupervisorWorkerRuntime({
    ...options.worker,
    database: options.database,
    bindingSource: gateway,
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
      supervisorWebSocketGateway: gateway,
      ...(options.supervisorProvisioningGateway === undefined
        ? {}
        : { supervisorProvisioningGateway: options.supervisorProvisioningGateway }),
      ...(options.productionHttpGateway === undefined
        ? {}
        : { productionHttpGateway: options.productionHttpGateway }),
      ...(options.githubWebhookGateway === undefined
        ? {}
        : { githubWebhookGateway: options.githubWebhookGateway }),
      ...(options.publicRegistration === undefined
        ? {}
        : { publicRegistration: options.publicRegistration }),
      ...(options.modelCredentialVault === undefined
        ? {}
        : { modelCredentialVault: options.modelCredentialVault }),
      eventRuntime: { eventHub, eventStore },
      ...(options.sessionEventNotifications === undefined
        ? {}
        : { sessionEventNotifications: options.sessionEventNotifications }),
      ...(options.sessionEventStreamOptions === undefined
        ? {}
        : { sessionEventStreamOptions: options.sessionEventStreamOptions }),
      ...(options.artifactReader === undefined ? {} : { artifactReader: options.artifactReader }),
      ...(options.githubGateway === undefined ? {} : { githubGateway: options.githubGateway }),
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
    commandRouter,
    connectionManager,
    gateway,
    worker,
  });
}
