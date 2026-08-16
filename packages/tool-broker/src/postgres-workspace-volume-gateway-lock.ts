import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import type { WorkspaceVolumeGatewayLock } from "./workspace-volume-gateway-contract.ts";

export class PostgresWorkspaceVolumeGatewayLock implements WorkspaceVolumeGatewayLock {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async withLock<T>(volumeId: string, run: () => Promise<T>): Promise<T> {
    return this.#database.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(hashtextextended(${`pi-cloud.workspace.${volumeId}`}, 0))`.execute(
        connection,
      );
      try {
        return await run();
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${`pi-cloud.workspace.${volumeId}`}, 0))`.execute(
          connection,
        );
      }
    });
  }
}
