import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("platform_runtime_settings")
    .addColumn("settings_key", "text", (column) => column.primaryKey())
    .addColumn("cube_proxy_enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("cube_proxy_url", "text")
    .addColumn("revision", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("updated_by_tenant_id", "uuid")
    .addColumn("updated_by_user_id", "uuid")
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("platform_runtime_settings_singleton", sql`settings_key = 'default'`)
    .addCheckConstraint(
      "platform_runtime_settings_actor_complete",
      sql`(updated_by_tenant_id is null) = (updated_by_user_id is null)`,
    )
    .addCheckConstraint(
      "platform_runtime_settings_proxy_complete",
      sql`not cube_proxy_enabled or cube_proxy_url is not null`,
    )
    .addCheckConstraint(
      "platform_runtime_settings_proxy_url_bounded",
      sql`cube_proxy_url is null or char_length(cube_proxy_url) between 9 and 2048`,
    )
    .addForeignKeyConstraint(
      "platform_runtime_settings_actor_fk",
      ["updated_by_tenant_id", "updated_by_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .execute();

  await sql`
    insert into platform_runtime_settings (
      settings_key,
      cube_proxy_enabled,
      cube_proxy_url,
      revision
    ) values ('default', false, null, 0)
  `.execute(db);

  await db.schema
    .createTable("platform_runtime_setting_changes")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("revision", "bigint", (column) => column.notNull().unique())
    .addColumn("actor_tenant_id", "uuid", (column) => column.notNull())
    .addColumn("actor_user_id", "uuid", (column) => column.notNull())
    .addColumn("cube_proxy_enabled", "boolean", (column) => column.notNull())
    .addColumn("cube_proxy_url_sha256", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "platform_runtime_setting_changes_digest_valid",
      sql`cube_proxy_url_sha256 is null or cube_proxy_url_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addForeignKeyConstraint(
      "platform_runtime_setting_changes_actor_fk",
      ["actor_tenant_id", "actor_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("platform_runtime_setting_changes").execute();
  await db.schema.dropTable("platform_runtime_settings").execute();
}
