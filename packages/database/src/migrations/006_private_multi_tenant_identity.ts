import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("tenant_runtime_policies")
    .addColumn("tenant_id", "uuid", (column) => column.primaryKey().references("tenants.id"))
    .addColumn("default_model_profile_id", "uuid", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(true))
    .addColumn("maximum_projects", "integer", (column) => column.notNull().defaultTo(100))
    .addColumn("maximum_sessions", "integer", (column) => column.notNull().defaultTo(1_000))
    .addColumn("maximum_unsettled_turns", "integer", (column) => column.notNull().defaultTo(100))
    .addColumn("maximum_concurrent_turns", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn("last_scheduled_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`'epoch'::timestamptz`),
    )
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "tenant_runtime_policies_default_profile_fk",
      ["tenant_id", "default_model_profile_id"],
      "model_profiles",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "tenant_runtime_policies_limits_positive",
      sql`maximum_projects > 0
          and maximum_sessions > 0
          and maximum_unsettled_turns > 0
          and maximum_concurrent_turns > 0
          and maximum_concurrent_turns <= maximum_unsettled_turns`,
    )
    .execute();

  await db.schema
    .createIndex("tenant_runtime_policies_scheduler")
    .on("tenant_runtime_policies")
    .columns(["enabled", "last_scheduled_at", "tenant_id"])
    .execute();

  await db.schema
    .createTable("tenant_api_credentials")
    .addColumn("credential_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("label", "text", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("secret_sha256", "text", (column) => column.notNull().unique())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("last_used_at", "timestamptz")
    .addForeignKeyConstraint(
      "tenant_api_credentials_tenant_user_fk",
      ["tenant_id", "user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "tenant_api_credentials_label_nonempty",
      sql`char_length(label) between 1 and 128`,
    )
    .addCheckConstraint(
      "tenant_api_credentials_role_valid",
      sql`role in ('owner', 'member', 'viewer')`,
    )
    .addCheckConstraint(
      "tenant_api_credentials_sha256_valid",
      sql`secret_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "tenant_api_credentials_expiry_valid",
      sql`expires_at is null or expires_at > created_at`,
    )
    .addCheckConstraint(
      "tenant_api_credentials_revocation_valid",
      sql`revoked_at is null or revoked_at >= created_at`,
    )
    .addCheckConstraint(
      "tenant_api_credentials_last_used_valid",
      sql`last_used_at is null or last_used_at >= created_at`,
    )
    .execute();

  await db.schema
    .createIndex("tenant_api_credentials_by_tenant_user")
    .on("tenant_api_credentials")
    .columns(["tenant_id", "user_id", "created_at"])
    .execute();

  await db.schema
    .createIndex("tenant_api_credentials_active")
    .on("tenant_api_credentials")
    .columns(["credential_id", "expires_at"])
    .where(sql<boolean>`revoked_at is null`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("tenant_api_credentials").ifExists().execute();
  await db.schema.dropTable("tenant_runtime_policies").ifExists().execute();
}
