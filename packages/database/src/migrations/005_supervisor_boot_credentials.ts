import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("supervisor_hosts")
    .addColumn("supervisor_id", "text", (column) => column.primaryKey())
    .addColumn("maximum_capacity", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull())
    .addCheckConstraint(
      "supervisor_hosts_identity_valid",
      sql`char_length(supervisor_id) between 1 and 256`,
    )
    .addCheckConstraint("supervisor_hosts_capacity_valid", sql`maximum_capacity between 1 and 256`)
    .execute();

  await db.schema
    .createTable("supervisor_boot_credentials")
    .addColumn("credential_id", "uuid", (column) => column.primaryKey())
    .addColumn("credential_sha256", "char(64)", (column) => column.notNull().unique())
    .addColumn("provision_request_id", "uuid", (column) => column.notNull().unique())
    .addColumn("sandbox_id", "uuid", (column) => column.notNull().unique())
    .addColumn("supervisor_id", "text", (column) => column.notNull())
    .addColumn("boot_id", "uuid", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addForeignKeyConstraint(
      "supervisor_boot_credentials_host_fk",
      ["supervisor_id"],
      "supervisor_hosts",
      ["supervisor_id"],
    )
    .addForeignKeyConstraint(
      "supervisor_boot_credentials_sandbox_identity_fk",
      ["sandbox_id", "supervisor_id", "boot_id"],
      "sandboxes",
      ["id", "supervisor_id", "boot_id"],
    )
    .addUniqueConstraint("supervisor_boot_credentials_boot_unique", ["supervisor_id", "boot_id"])
    .addCheckConstraint(
      "supervisor_boot_credentials_digest_valid",
      sql`credential_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "supervisor_boot_credentials_lifetime_valid",
      sql`expires_at > created_at and (revoked_at is null or revoked_at >= created_at)`,
    )
    .execute();

  await db.schema
    .createIndex("supervisor_boot_credentials_authorization")
    .on("supervisor_boot_credentials")
    .columns(["credential_id", "expires_at"])
    .where(sql<boolean>`revoked_at is null`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("supervisor_boot_credentials").execute();
  await db.schema.dropTable("supervisor_hosts").execute();
}
