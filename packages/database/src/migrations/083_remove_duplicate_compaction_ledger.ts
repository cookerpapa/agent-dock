import type { Kysely } from "kysely";

/**
 * Pi SessionStorage owns native compaction entries and Kafka owns the durable
 * live event. The former governance table stopped receiving writes after that
 * cutover, so retaining it presents a false second source of truth.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("context_compactions").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "083_remove_duplicate_compaction_ledger is an intentional destructive cleanup; restore a pre-migration backup to roll back",
  );
}
