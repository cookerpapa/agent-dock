import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { ControlPlaneModule, type ControlPlaneEventRuntime } from "./control-plane.module.ts";
import type { ControlPlaneStoreOptions } from "./control-plane-store.ts";
import type { SessionEventNotificationTransport } from "@agent-dock/runtime-core/session-event-notifications";
import type { SessionEventStreamOptions } from "@agent-dock/runtime-core/session-event-stream";
import type { SupervisorWebSocketGateway } from "./supervisor-websocket-gateway.ts";
import type { TurnSteerBackend } from "./turn-steer.ts";
import type { SupervisorProvisioningGateway } from "./supervisor-boot-provisioner.ts";
import type { ProductionHttpGateway } from "./production-http-gateway.ts";
import type { PublicTenantRegistrationConfiguration } from "./public-tenant-registration.ts";
import type { TenantModelCredentialVault } from "@agent-dock/runtime-core/model-credential-runtime";
import type {
  TrustedArtifactReader,
  TrustedProviderSnapshotReader,
} from "./workspace-version-service.ts";
import type { WebAuthenticationService } from "./web-authentication.ts";
import type { WorkspaceTerminalGateway } from "./workspace-terminal-gateway.ts";

export type ControlPlaneApplicationOptions = Omit<
  ControlPlaneStoreOptions,
  "tenantId" | "defaultModelProfileId"
> & {
  tenantId?: string;
  defaultModelProfileId?: string;
  supervisorWebSocketGateway?: SupervisorWebSocketGateway;
  turnSteerBackendFactory?: (sandboxId: string) => Promise<TurnSteerBackend>;
  supervisorProvisioningGateway?: SupervisorProvisioningGateway;
  productionHttpGateway?: ProductionHttpGateway;
  sessionEventNotifications?: SessionEventNotificationTransport;
  sessionEventStreamOptions?: SessionEventStreamOptions;
  eventRuntime?: ControlPlaneEventRuntime;
  publicRegistration?: PublicTenantRegistrationConfiguration;
  modelCredentialVault?: TenantModelCredentialVault;
  artifactReader?: TrustedArtifactReader;
  providerSnapshotReader?: TrustedProviderSnapshotReader;
  advancedModulesEnabled?: boolean;
  webAuthentication?: WebAuthenticationService;
  platformOperatorTenantId?: string;
  platformModelSourceTenantId?: string;
  cubeEgressConfigToken?: string;
  workspaceTerminalGateway?: WorkspaceTerminalGateway;
};

export async function createControlPlaneApplication(
  options: ControlPlaneApplicationOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ logger: false });
  options.productionHttpGateway?.install(adapter.getInstance());
  options.supervisorProvisioningGateway?.install(adapter.getInstance());
  options.supervisorWebSocketGateway?.install(adapter.getInstance());
  options.workspaceTerminalGateway?.install(adapter.getInstance());
  let staticRequestIdentity;
  if (options.productionHttpGateway === undefined) {
    if (options.tenantId === undefined || options.defaultModelProfileId === undefined) {
      throw new TypeError(
        "Development control plane requires an explicit static tenant and model profile",
      );
    }
    staticRequestIdentity = {
      credentialId: "00000000-0000-4000-8000-000000000000",
      tenantId: options.tenantId,
      tenantSlug: "development",
      userId: "00000000-0000-4000-8000-000000000001",
      displayName: "Development Operator",
      role: "owner" as const,
      defaultModelProfileId: options.defaultModelProfileId,
    };
  }
  const application = await NestFactory.create<NestFastifyApplication>(
    ControlPlaneModule.register({
      ...options,
      ...(staticRequestIdentity === undefined ? {} : { staticRequestIdentity }),
    }),
    adapter,
    { logger: false },
  );
  application.useGlobalFilters(new ApiExceptionFilter());
  await application.init();
  return application;
}
