import { createDatabase } from "@agent-dock/database";
import { operationalLog, startServiceObservability } from "@agent-dock/observability";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import {
  HttpSupervisorManagementClient,
  HttpSupervisorSteerBackend,
  RoutedHttpSandboxAssignmentInventory,
  RoutedHttpSupervisorOwnerBoundary,
} from "./http-supervisor-management.ts";
import { SessionLeaseCoordinator } from "@agent-dock/runtime-core/session-lease-coordinator";
import { createS3CheckpointObjectStoreFromEnvironment } from "@agent-dock/runtime-core/s3-checkpoint-object-store";
import { PostgresSessionEventNotifications } from "@agent-dock/runtime-core/postgres-session-event-notifications";
import { HttpDurableEventIngestor } from "@agent-dock/runtime-core/http-durable-event-ingestor";
import { HttpTerminalTurnProjectionSource } from "@agent-dock/runtime-core/terminal-turn-projection";
import {
  PostgresSupervisorCredentialAuthorizer,
  SupervisorBootProvisioner,
  SupervisorProvisioningGateway,
} from "./supervisor-boot-provisioner.ts";
import { loadProductionControlPlaneConfig } from "./production-config.ts";
import { ProductionHttpGateway } from "./production-http-gateway.ts";
import { PostgresTenantApiAuthenticator } from "./tenant-identity.ts";
import { TenantModelCredentialVault } from "@agent-dock/runtime-core/model-credential-runtime";
import { resolvePlatformInitialModel } from "./platform-model-configuration.ts";
import { WebAuthenticationService } from "./web-authentication.ts";
import { createControlPlaneRuntime, type ControlPlaneRuntime } from "./control-plane-runtime.ts";
import { TemporalRunOrchestrator } from "./temporal-run-orchestrator.ts";
import { ReplicatedToolBrokerClient } from "@agent-dock/tool-broker/client";
import { encodeWorkspaceSnapshotBlob } from "@agent-dock/workspace-runtime";

async function verifyBootstrap(database: ReturnType<typeof createDatabase>): Promise<void> {
  const profile = await database
    .selectFrom("tenant_runtime_policies as policy")
    .innerJoin("model_profiles as profile", (join) =>
      join
        .onRef("profile.tenant_id", "=", "policy.tenant_id")
        .onRef("profile.id", "=", "policy.default_model_profile_id"),
    )
    .select("policy.tenant_id")
    .where("profile.enabled", "=", true)
    .limit(1)
    .executeTakeFirst();
  if (profile === undefined) {
    throw new Error("Production database bootstrap is missing or inconsistent");
  }
}

export async function startControlPlane(): Promise<void> {
  const config = await loadProductionControlPlaneConfig();
  const observability = await startServiceObservability({
    serviceName: "agent-dock-control-plane",
    defaultMetricsPort: 9464,
  });
  const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
  const notifications = new PostgresSessionEventNotifications({
    // LISTEN requires a session connection and must bypass PgBouncer's
    // transaction pool in distributed deployments.
    connectionString: config.databaseNotificationUrl,
  });
  const objectStore = createS3CheckpointObjectStoreFromEnvironment();
  let runtime: ControlPlaneRuntime | undefined;
  let temporalOrchestrator: TemporalRunOrchestrator | undefined;
  let closing = false;
  try {
    await verifyBootstrap(database);
    const modelCredentialVault = new TenantModelCredentialVault(config.modelCredentialMasterKey);
    const platformInitialModel = await resolvePlatformInitialModel(
      database,
      modelCredentialVault,
      config.platformModelSourceTenantId,
    );
    const registrationConfiguration = {
      ...config.publicRegistration,
      ...(platformInitialModel === undefined ? {} : { initialModel: platformInitialModel }),
    };
    const webAuthentication = new WebAuthenticationService({
      database,
      ...registrationConfiguration,
      initialModel: () =>
        resolvePlatformInitialModel(
          database,
          modelCredentialVault,
          config.platformModelSourceTenantId,
        ),
      secureCookie: config.webSessionCookieSecure,
      sessionTtlMs: config.webSessionTtlMs,
      platformOperatorTenantId: config.platformOperatorTenantId,
    });
    await objectStore.checkHealth();
    temporalOrchestrator = new TemporalRunOrchestrator({
      database,
      address: config.temporalAddress,
      namespace: config.temporalNamespace,
      onActivity: (activity) =>
        operationalLog({
          service: "agent-dock-control-plane",
          level: activity.type === "orchestrator.failure" ? "error" : "info",
          event: activity.type,
          attributes: { ...activity },
        }),
    });
    await temporalOrchestrator.start();
    const managementClients = new Map<string, HttpSupervisorManagementClient>();
    const resolveManagementClient = async (identity: {
      supervisorId: string;
      bootId: string;
      sandboxId: string;
    }): Promise<HttpSupervisorManagementClient> => {
      const host = await database
        .selectFrom("supervisor_hosts as host")
        .innerJoin("sandboxes as sandbox", "sandbox.supervisor_id", "host.supervisor_id")
        .select("host.management_base_url")
        .where("sandbox.id", "=", identity.sandboxId)
        .where("sandbox.supervisor_id", "=", identity.supervisorId)
        .where("sandbox.boot_id", "=", identity.bootId)
        .executeTakeFirst();
      if (host === undefined) {
        throw new Error("Supervisor management identity is not registered");
      }
      let client = managementClients.get(host.management_base_url);
      if (client === undefined) {
        client = new HttpSupervisorManagementClient({
          baseUrl: host.management_base_url,
          managementToken: config.supervisorManagementToken,
          allowInsecureHttp: config.allowInsecureInternalHttp,
        });
        managementClients.set(host.management_base_url, client);
      }
      return client;
    };
    const resolveSteerBackend = async (sandboxId: string): Promise<HttpSupervisorSteerBackend> => {
      const identity = await database
        .selectFrom("sandboxes")
        .select(["supervisor_id", "boot_id"])
        .where("id", "=", sandboxId)
        .executeTakeFirst();
      if (identity === undefined) throw new Error("Active Pi Worker identity is unavailable");
      return new HttpSupervisorSteerBackend({
        client: await resolveManagementClient({
          supervisorId: identity.supervisor_id,
          bootId: identity.boot_id,
          sandboxId,
        }),
        leaseCoordinator: new SessionLeaseCoordinator({ database, sandboxId }),
      });
    };
    const snapshotMaterializer = new ReplicatedToolBrokerClient({
      baseUrls: config.toolBrokerBaseUrls,
      serviceToken: config.sandboxMaterializerToken,
      allowInsecureHttp: config.allowInsecureInternalHttp,
    });
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: config.supervisorIdPrefix,
      managementBaseUrlTemplates: config.supervisorManagementBaseUrlTemplates,
      maximumCapacity: config.supervisorMaximumCapacity,
      enrollmentToken: config.supervisorEnrollmentToken,
    });
    const provisioningGateway = new SupervisorProvisioningGateway({ provisioner });
    const httpGateway = new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database }),
      publicRegistrationEnabled: config.publicRegistration.enabled,
      webSessionAuthenticator: webAuthentication,
      readiness: async () => {
        if (runtime?.state !== "running") return false;
        await Promise.all([
          sql`select 1`.execute(database),
          temporalOrchestrator?.checkHealth() ??
            Promise.reject(new Error("Temporal orchestration is unavailable")),
          snapshotMaterializer.checkHealth(),
        ]);
        return true;
      },
    });
    const workerEventIngestor = config.externalWorkerEventLog
      ? new HttpDurableEventIngestor({
          baseUrl: config.workerEventIngestBaseUrl!,
          serviceToken: config.workerEventIngestToken!,
          allowInsecureHttp: config.allowInsecureInternalHttp,
        })
      : undefined;
    const terminalTurnProjectionSource = config.externalWorkerEventLog
      ? new HttpTerminalTurnProjectionSource({
          baseUrl: config.workerEventIngestBaseUrl!,
          serviceToken: config.workerEventIngestToken!,
        })
      : undefined;
    runtime = await createControlPlaneRuntime({
      database,
      ...(workerEventIngestor === undefined ? {} : { workerEventIngestor }),
      ...(terminalTurnProjectionSource === undefined ? {} : { terminalTurnProjectionSource }),
      controlPlaneInstanceId: randomUUID(),
      sessionEventNotifications: notifications,
      supervisorAuthorizer: new PostgresSupervisorCredentialAuthorizer({ database }),
      supervisorOwnerBoundary: new RoutedHttpSupervisorOwnerBoundary(resolveManagementClient),
      assignmentInventoryFactory: (identity) =>
        new RoutedHttpSandboxAssignmentInventory(resolveManagementClient, identity),
      supervisorProvisioningGateway: provisioningGateway,
      turnSteerBackendFactory: resolveSteerBackend,
      productionHttpGateway: httpGateway,
      publicRegistration: registrationConfiguration,
      webAuthentication,
      modelCredentialVault,
      platformOperatorTenantId: config.platformOperatorTenantId,
      platformModelSourceTenantId: config.platformModelSourceTenantId,
      cubeEgressConfigToken: config.cubeEgressConfigToken,
      environmentImageRevision: config.environmentImageRevision,
      artifactReader: { get: (objectKey) => objectStore.get(objectKey) },
      providerSnapshotReader: {
        read: async (input) => {
          const response = await snapshotMaterializer.materializeFile({
            toolBrokerProtocolVersion: 1,
            type: "workspace.materialize_file",
            requestId: randomUUID(),
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            snapshot: encodeWorkspaceSnapshotBlob(input.snapshot),
            path: input.path,
          });
          return {
            bytes: Buffer.from(response.content, "base64"),
            sha256: response.sha256,
            executable: response.executable,
          };
        },
      },
      advancedModulesEnabled: config.advancedModulesEnabled,
      maintenance: {
        onActivity: (activity) =>
          operationalLog({
            service: "agent-dock-control-plane",
            level: activity.type === "runtime.failure" ? "error" : "info",
            event: activity.type,
            attributes: { ...activity },
          }),
      },
    });
    await runtime.listen(config.port, config.host);
    process.stdout.write(
      `AgentDock production control plane listening on ${config.host}:${String(config.port)}\n`,
    );

    const close = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      await temporalOrchestrator?.stop();
      await runtime?.close();
      objectStore.destroy();
      await database.destroy();
      await observability.close();
    };
    const closeAfterSignal = (): void => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", closeAfterSignal);
    process.once("SIGTERM", closeAfterSignal);
  } catch (error: unknown) {
    closing = true;
    await temporalOrchestrator?.stop().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await notifications.stop().catch(() => undefined);
    objectStore.destroy();
    await database.destroy();
    await observability.close().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startControlPlane().catch(() => {
    process.stderr.write("AgentDock production control plane failed to start\n");
    process.exitCode = 1;
  });
}
