import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { ControlPlaneModule } from "./control-plane.module.ts";
import type { ControlPlaneStoreOptions } from "./control-plane-store.ts";
import type { SupervisorWebSocketGateway } from "./supervisor-websocket-gateway.ts";

export type ControlPlaneApplicationOptions = ControlPlaneStoreOptions & {
  supervisorWebSocketGateway?: SupervisorWebSocketGateway;
};

export async function createControlPlaneApplication(
  options: ControlPlaneApplicationOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ logger: false });
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
