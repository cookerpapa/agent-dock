import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_password_credentials")
    .addColumn("username", "text", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("password_salt", "text", (column) => column.notNull())
    .addColumn("password_hash", "text", (column) => column.notNull())
    .addColumn("scrypt_n", "integer", (column) => column.notNull())
    .addColumn("scrypt_r", "integer", (column) => column.notNull())
    .addColumn("scrypt_p", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("user_password_credentials_tenant_user_unique", ["tenant_id", "user_id"])
    .addForeignKeyConstraint(
      "user_password_credentials_tenant_user_fk",
      ["tenant_id", "user_id"],
      "users",
      ["tenant_id", "id"],
    )
    .addCheckConstraint(
      "user_password_credentials_username_valid",
      sql`username ~ '^[a-z0-9][a-z0-9._-]{2,47}$'`,
    )
    .addCheckConstraint(
      "user_password_credentials_role_valid",
      sql`role in ('owner', 'member', 'viewer')`,
    )
    .addCheckConstraint(
      "user_password_credentials_crypto_valid",
      sql`password_salt ~ '^[A-Za-z0-9_-]{22}$'
          and password_hash ~ '^[A-Za-z0-9_-]{43}$'
          and scrypt_n between 16384 and 1048576
          and (scrypt_n & (scrypt_n - 1)) = 0
          and scrypt_r between 1 and 32
          and scrypt_p between 1 and 16`,
    )
    .execute();

  await db.schema
    .createTable("web_sessions")
    .addColumn("session_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("secret_sha256", "text", (column) => column.notNull().unique())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("last_used_at", "timestamptz")
    .addForeignKeyConstraint("web_sessions_tenant_user_fk", ["tenant_id", "user_id"], "users", [
      "tenant_id",
      "id",
    ])
    .addCheckConstraint("web_sessions_role_valid", sql`role in ('owner', 'member', 'viewer')`)
    .addCheckConstraint("web_sessions_sha256_valid", sql`secret_sha256 ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint("web_sessions_expiry_valid", sql`expires_at > created_at`)
    .addCheckConstraint(
      "web_sessions_revocation_valid",
      sql`revoked_at is null or revoked_at >= created_at`,
    )
    .addCheckConstraint(
      "web_sessions_last_used_valid",
      sql`last_used_at is null or last_used_at >= created_at`,
    )
    .execute();

  await db.schema
    .createIndex("web_sessions_active_user")
    .on("web_sessions")
    .columns(["tenant_id", "user_id", "expires_at"])
    .where(sql<boolean>`revoked_at is null`)
    .execute();

  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_import_state_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_shape_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_kind_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_kind_valid",
      sql`kind in ('empty', 'sample_java', 'github_public', 'github_app')`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_shape_valid",
      sql`(
            kind in ('empty', 'sample_java')
            and repository is null
            and commit_sha is null
            and github_installation_id is null
            and github_repository_id is null
            and status = 'ready'
            and object_key is null
            and import_lease_id is null
            and lease_expires_at is null
            and failure_code is null
          ) or (
            kind = 'github_public'
            and repository is not null
            and commit_sha is not null
            and github_installation_id is null
            and github_repository_id is null
          ) or (
            kind = 'github_app'
            and repository is not null
            and commit_sha is not null
            and github_installation_id is not null
            and github_repository_id is not null
          )`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_import_state_valid",
      sql`kind in ('empty', 'sample_java') or (
            (status = 'pending'
              and object_key is null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code is null)
            or (status = 'importing'
              and object_key is null
              and import_lease_id is not null
              and lease_expires_at is not null
              and failure_code is null)
            or (status = 'ready'
              and object_key is not null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code is null)
            or (status = 'failed'
              and object_key is null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code ~ '^[a-z][a-z0-9_]{0,127}$')
          )`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update workspace_sources set kind = 'sample_java' where kind = 'empty'`.execute(db);
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_import_state_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_shape_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .dropConstraint("workspace_sources_kind_valid")
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_kind_valid",
      sql`kind in ('sample_java', 'github_public', 'github_app')`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_shape_valid",
      sql`(
            kind = 'sample_java'
            and repository is null
            and commit_sha is null
            and github_installation_id is null
            and github_repository_id is null
            and status = 'ready'
            and object_key is null
            and import_lease_id is null
            and lease_expires_at is null
            and failure_code is null
          ) or (
            kind = 'github_public'
            and repository is not null
            and commit_sha is not null
            and github_installation_id is null
            and github_repository_id is null
          ) or (
            kind = 'github_app'
            and repository is not null
            and commit_sha is not null
            and github_installation_id is not null
            and github_repository_id is not null
          )`,
    )
    .execute();
  await db.schema
    .alterTable("workspace_sources")
    .addCheckConstraint(
      "workspace_sources_import_state_valid",
      sql`kind = 'sample_java' or (
            (status = 'pending'
              and object_key is null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code is null)
            or (status = 'importing'
              and object_key is null
              and import_lease_id is not null
              and lease_expires_at is not null
              and failure_code is null)
            or (status = 'ready'
              and object_key is not null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code is null)
            or (status = 'failed'
              and object_key is null
              and import_lease_id is null
              and lease_expires_at is null
              and failure_code ~ '^[a-z][a-z0-9_]{0,127}$')
          )`,
    )
    .execute();
  await db.schema.dropTable("web_sessions").ifExists().execute();
  await db.schema.dropTable("user_password_credentials").ifExists().execute();
}
