import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("tenant_model_credentials")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("credential_binding_id", "uuid", (column) => column.notNull())
    .addColumn("credential_binding_version", "bigint", (column) => column.notNull())
    .addColumn("key_version", "integer", (column) => column.notNull())
    .addColumn("nonce", "text", (column) => column.notNull())
    .addColumn("ciphertext", "text", (column) => column.notNull())
    .addColumn("auth_tag", "text", (column) => column.notNull())
    .addColumn("secret_sha256", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("tenant_model_credentials_pk", [
      "tenant_id",
      "credential_binding_id",
      "credential_binding_version",
    ])
    .addForeignKeyConstraint(
      "tenant_model_credentials_binding_fk",
      ["tenant_id", "credential_binding_id", "credential_binding_version"],
      "credential_bindings",
      ["tenant_id", "id", "version"],
    )
    .addCheckConstraint(
      "tenant_model_credentials_versions_positive",
      sql`credential_binding_version > 0 and key_version > 0`,
    )
    .addCheckConstraint("tenant_model_credentials_nonce_valid", sql`nonce ~ '^[A-Za-z0-9_-]{16}$'`)
    .addCheckConstraint(
      "tenant_model_credentials_ciphertext_valid",
      sql`char_length(ciphertext) between 16 and 16384
          and ciphertext ~ '^[A-Za-z0-9_-]+$'`,
    )
    .addCheckConstraint(
      "tenant_model_credentials_auth_tag_valid",
      sql`auth_tag ~ '^[A-Za-z0-9_-]{22}$'`,
    )
    .addCheckConstraint(
      "tenant_model_credentials_sha256_valid",
      sql`secret_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .execute();

  await db.schema
    .createIndex("tenant_model_credentials_by_binding")
    .on("tenant_model_credentials")
    .columns(["tenant_id", "credential_binding_id", "credential_binding_version"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("tenant_model_credentials").ifExists().execute();
}
