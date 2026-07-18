import { Migrator, type MigrationResult } from "kysely/migration";
import type { Kysely } from "kysely";
import type { Database } from "./database-types.ts";
import { migrationProvider } from "./migrations/index.ts";

export type MigrationDirection = "up" | "down";

export type MigrationRunResult = {
  direction: MigrationDirection;
  results: readonly MigrationResult[];
};

export async function runMigrations(
  db: Kysely<Database>,
  direction: MigrationDirection,
): Promise<MigrationRunResult> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const result = direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();
  if (result.error) {
    throw result.error;
  }
  return {
    direction,
    results: result.results ?? [],
  };
}
