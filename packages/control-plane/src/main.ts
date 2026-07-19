import { createDatabase } from "@agent-dock/database";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import {
  HttpSandboxAssignmentInventory,
  HttpSupervisorManagementClient,
  HttpSupervisorOwnerBoundary,
} from "./http-supervisor-management.ts";
import { PostgresSessionEventNotifications } from "./postgres-session-event-notifications.ts";
import {
  PostgresSupervisorCredentialAuthorizer,
  SupervisorBootProvisioner,
  SupervisorProvisioningGateway,
} from "./supervisor-boot-provisioner.ts";
import { loadProductionControlPlaneConfig } from "./production-config.ts";
import { ProductionHttpGateway } from "./production-http-gateway.ts";
import { PostgresTenantApiAuthenticator } from "./tenant-identity.ts";
import { TenantModelCredentialVault } from "./model-credential-runtime.ts";
import {
  createRemoteControlPlaneRuntime,
  type RemoteControlPlaneRuntime,
} from "./remote-control-plane-runtime.ts";

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
  const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
  const notifications = new PostgresSessionEventNotifications({
    connectionString: config.databaseUrl,
  });
  let runtime: RemoteControlPlaneRuntime | undefined;
  try {
    await verifyBootstrap(database);
    const managementClient = new HttpSupervisorManagementClient({
      baseUrl: config.supervisorManagementBaseUrl,
      managementToken: config.supervisorManagementToken,
      allowInsecureHttp: config.allowInsecureInternalHttp,
    });
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorId: config.supervisorId,
      maximumCapacity: config.supervisorMaximumCapacity,
      enrollmentToken: config.supervisorEnrollmentToken,
    });
    const provisioningGateway = new SupervisorProvisioningGateway({ provisioner });
    const httpGateway = new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database }),
      publicRegistrationEnabled: config.publicRegistration.enabled,
      readiness: async () => {
        if (runtime?.state !== "running") return false;
        await sql`select 1`.execute(database);
        return true;
      },
    });
    runtime = await createRemoteControlPlaneRuntime({
      database,
      controlPlaneInstanceId: randomUUID(),
      sessionEventNotifications: notifications,
      supervisorAuthorizer: new PostgresSupervisorCredentialAuthorizer({ database }),
      supervisorOwnerBoundary: new HttpSupervisorOwnerBoundary(managementClient),
      assignmentInventoryFactory: (identity) =>
        new HttpSandboxAssignmentInventory(managementClient, identity.sandboxId),
      supervisorProvisioningGateway: provisioningGateway,
      productionHttpGateway: httpGateway,
      publicRegistration: config.publicRegistration,
      modelCredentialVault: new TenantModelCredentialVault(config.modelCredentialMasterKey),
      worker: { maxLanesPerConnection: config.maximumLanesPerSupervisor },
    });
    await runtime.listen(config.port, config.host);
    process.stdout.write(
      `AgentDock production control plane listening on ${config.host}:${String(config.port)}\n`,
    );

    let closing = false;
    const close = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      await runtime?.close();
      await database.destroy();
    };
    const closeAfterSignal = (): void => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", closeAfterSignal);
    process.once("SIGTERM", closeAfterSignal);
  } catch (error: unknown) {
    await runtime?.close().catch(() => undefined);
    await notifications.stop().catch(() => undefined);
    await database.destroy();
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
