import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import type { WorkspaceVolumeGatewayLock } from "./workspace-volume-gateway-contract.ts";

export class PostgresWorkspaceVolumeGatewayLock implements WorkspaceVolumeGatewayLock {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async withLock<T>(volumeId: string, run: () => Promise<T>): Promise<T> {
    return this.withLocks([volumeId], run);
  }

  async withLocks<T>(volumeIds: readonly string[], run: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(volumeIds)].sort();
    if (ordered.length < 1) return run();
    return this.#database.connection().execute(async (connection) => {
      const acquired: string[] = [];
      try {
        for (const volumeId of ordered) {
          await sql`select pg_advisory_lock(hashtextextended(${`pi-cloud.workspace.${volumeId}`}, 0))`.execute(
            connection,
          );
          acquired.push(volumeId);
        }
        return await run();
      } finally {
        for (const volumeId of acquired.reverse()) {
          await sql`select pg_advisory_unlock(hashtextextended(${`pi-cloud.workspace.${volumeId}`}, 0))`.execute(
            connection,
          );
        }
      }
    });
  }
}
