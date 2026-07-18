import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { ControlPlaneModule } from "./control-plane.module.ts";
import type { ControlPlaneStoreOptions } from "./control-plane-store.ts";

export async function createControlPlaneApplication(
  options: ControlPlaneStoreOptions,
): Promise<NestFastifyApplication> {
  const application = await NestFactory.create<NestFastifyApplication>(
    ControlPlaneModule.register(options),
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );
  application.useGlobalFilters(new ApiExceptionFilter());
  await application.init();
  return application;
}
