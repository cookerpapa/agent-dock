import { sql, type Kysely } from "kysely";

const defaultRecipe = {
  schemaVersion: 1,
  setupCommands: [],
  verificationCommands: [
    {
      id: "git-worktree",
      command: "git status --short",
      cwd: ".",
      timeoutMs: 10_000,
      network: "none",
    },
  ],
};

const defaultRecipeSha256 = "5a851a442529ef2a092e5fb4f8f217703766a0142b267e4beb14fb1201aa1b6d";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("environment_versions")
    .addColumn("recipe", "jsonb", (column) =>
      column.notNull().defaultTo(sql`${sql.lit(JSON.stringify(defaultRecipe))}::jsonb`),
    )
    .addColumn("recipe_sha256", "text", (column) => column.notNull().defaultTo(defaultRecipeSha256))
    .addColumn("created_by_user_id", "uuid")
    .addColumn("failure_code", "text")
    .execute();

  await sql`
    update environment_versions
       set failure_code = 'legacy_environment_validation_failed'
     where state = 'failed'
       and failure_code is null
  `.execute(db);

  await db.schema
    .alterTable("environment_versions")
    .addForeignKeyConstraint(
      "environment_versions_creator_fk",
      ["tenant_id", "created_by_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("environment_versions")
    .addCheckConstraint(
      "environment_versions_recipe_sha256_valid",
      sql`recipe_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .execute();
  await db.schema
    .alterTable("environment_versions")
    .addCheckConstraint(
      "environment_versions_failure_shape",
      sql`(state = 'failed' and failure_code is not null)
          or (state <> 'failed' and failure_code is null)`,
    )
    .execute();

  await db.schema
    .createTable("environment_operations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("project_id", "uuid", (column) => column.notNull())
    .addColumn("actor_user_id", "uuid", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("from_environment_version_id", "uuid")
    .addColumn("to_environment_version_id", "uuid", (column) => column.notNull())
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("request_fingerprint", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("environment_operations_idempotency_unique", [
      "tenant_id",
      "project_id",
      "idempotency_key",
    ])
    .addUniqueConstraint("environment_operations_tenant_id_unique", ["tenant_id", "id"])
    .addForeignKeyConstraint(
      "environment_operations_project_fk",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "environment_operations_actor_fk",
      ["tenant_id", "actor_user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addForeignKeyConstraint(
      "environment_operations_from_environment_fk",
      ["tenant_id", "project_id", "from_environment_version_id"],
      "environment_versions",
      ["tenant_id", "project_id", "id"],
    )
    .addForeignKeyConstraint(
      "environment_operations_to_environment_fk",
      ["tenant_id", "project_id", "to_environment_version_id"],
      "environment_versions",
      ["tenant_id", "project_id", "id"],
    )
    .addCheckConstraint(
      "environment_operations_kind_valid",
      sql`kind in ('create', 'activate', 'rollback', 'validate')`,
    )
    .addCheckConstraint(
      "environment_operations_fingerprint_valid",
      sql`request_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .execute();

  await db.schema
    .createIndex("environment_operations_project_created_index")
    .on("environment_operations")
    .columns(["tenant_id", "project_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("environment_operations").execute();
  await db.schema
    .alterTable("environment_versions")
    .dropConstraint("environment_versions_failure_shape")
    .execute();
  await db.schema
    .alterTable("environment_versions")
    .dropConstraint("environment_versions_recipe_sha256_valid")
    .execute();
  await db.schema
    .alterTable("environment_versions")
    .dropConstraint("environment_versions_creator_fk")
    .execute();
  for (const column of ["failure_code", "created_by_user_id", "recipe_sha256", "recipe"] as const) {
    await db.schema.alterTable("environment_versions").dropColumn(column).execute();
  }
}
