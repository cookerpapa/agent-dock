import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { ControlPlaneModule, type ControlPlaneEventRuntime } from "./control-plane.module.ts";
import type { ControlPlaneStoreOptions } from "./control-plane-store.ts";
import type { SessionEventNotificationTransport } from "./session-event-notifications.ts";
import type { SessionEventStreamOptions } from "./session-event-stream.ts";
import type { SupervisorWebSocketGateway } from "./supervisor-websocket-gateway.ts";
import type { SupervisorProvisioningGateway } from "./supervisor-boot-provisioner.ts";
import type { ProductionHttpGateway } from "./production-http-gateway.ts";

export type ControlPlaneApplicationOptions = ControlPlaneStoreOptions & {
  supervisorWebSocketGateway?: SupervisorWebSocketGateway;
  supervisorProvisioningGateway?: SupervisorProvisioningGateway;
  productionHttpGateway?: ProductionHttpGateway;
  sessionEventNotifications?: SessionEventNotificationTransport;
  sessionEventStreamOptions?: SessionEventStreamOptions;
  eventRuntime?: ControlPlaneEventRuntime;
};

export async function createControlPlaneApplication(
  options: ControlPlaneApplicationOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ logger: false });
  options.productionHttpGateway?.install(adapter.getInstance());
  options.supervisorProvisioningGateway?.install(adapter.getInstance());
  options.supervisorWebSocketGateway?.install(adapter.getInstance());
  const application = await NestFactory.create<NestFastifyApplication>(
    ControlPlaneModule.register(options),
    adapter,
    { logger: false },
  );
  application.useGlobalFilters(new ApiExceptionFilter());
  await application.init();
  return application;
}
