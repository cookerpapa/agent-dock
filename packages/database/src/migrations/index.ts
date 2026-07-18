import type { MigrationProvider } from "kysely/migration";
import * as initialControlPlane from "./001_initial_control_plane.ts";

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      "001_initial_control_plane": initialControlPlane,
    };
  },
};

export {
  down as downInitialControlPlane,
  up as upInitialControlPlane,
} from "./001_initial_control_plane.ts";
