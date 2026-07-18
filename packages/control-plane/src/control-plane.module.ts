import { Module, type DynamicModule } from "@nestjs/common";
import { ControlPlaneController, CONTROL_PLANE_STORE } from "./control-plane.controller.ts";
import { ControlPlaneStore, type ControlPlaneStoreOptions } from "./control-plane-store.ts";

@Module({})
export class ControlPlaneModule {
  static register(options: ControlPlaneStoreOptions): DynamicModule {
    return {
      module: ControlPlaneModule,
      controllers: [ControlPlaneController],
      providers: [
        {
          provide: CONTROL_PLANE_STORE,
          useValue: new ControlPlaneStore(options),
        },
      ],
    };
  }
}
