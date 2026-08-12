import type { Database } from "@agent-dock/database";
import { sql, type Kysely } from "kysely";
import type { WorkspaceDataMoverLock } from "./workspace-data-mover-contract.ts";

export class PostgresWorkspaceDataMoverLock implements WorkspaceDataMoverLock {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async withLock<T>(volumeId: string, run: () => Promise<T>): Promise<T> {
    return this.#database.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(hashtextextended(${`agent-dock.workspace.${volumeId}`}, 0))`.execute(
        connection,
      );
      try {
        return await run();
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${`agent-dock.workspace.${volumeId}`}, 0))`.execute(
          connection,
        );
      }
    });
  }
}
