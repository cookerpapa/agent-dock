import { sql, type Kysely } from "kysely";

const previousRecipe = {
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

const previousRecipeSha256 = "5a851a442529ef2a092e5fb4f8f217703766a0142b267e4beb14fb1201aa1b6d";

const externalGitRecipe = {
  schemaVersion: 1,
  setupCommands: [],
  verificationCommands: [
    {
      id: "workspace-root",
      command: 'test "$PWD" = /workspace && test -w .',
      cwd: ".",
      timeoutMs: 10_000,
      network: "none",
    },
  ],
};

const externalGitRecipeSha256 = "2d6c5260fe7bc3901e454ff93106dc5ed263d6edbbabf7bafdf852021289e5ba";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from environment_validations as validation
     using environment_versions as environment
     where validation.tenant_id = environment.tenant_id
       and validation.project_id = environment.project_id
       and validation.environment_version_id = environment.id
       and environment.recipe_sha256 = ${previousRecipeSha256}
       and environment.recipe = ${JSON.stringify(previousRecipe)}::jsonb
  `.execute(db);

  await sql`
    update environment_versions
       set recipe = ${JSON.stringify(externalGitRecipe)}::jsonb,
           recipe_sha256 = ${externalGitRecipeSha256},
           state = 'pending',
           validated_at = null,
           failure_code = null,
           updated_at = now()
     where recipe_sha256 = ${previousRecipeSha256}
       and recipe = ${JSON.stringify(previousRecipe)}::jsonb
  `.execute(db);

  await db.schema
    .alterTable("environment_versions")
    .alterColumn("recipe", (column) =>
      column.setDefault(sql`${sql.lit(JSON.stringify(externalGitRecipe))}::jsonb`),
    )
    .alterColumn("recipe_sha256", (column) => column.setDefault(externalGitRecipeSha256))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update environment_versions
       set recipe = ${JSON.stringify(previousRecipe)}::jsonb,
           recipe_sha256 = ${previousRecipeSha256},
           state = 'pending',
           validated_at = null,
           failure_code = null,
           updated_at = now()
     where recipe_sha256 = ${externalGitRecipeSha256}
       and recipe = ${JSON.stringify(externalGitRecipe)}::jsonb
  `.execute(db);

  await db.schema
    .alterTable("environment_versions")
    .alterColumn("recipe", (column) =>
      column.setDefault(sql`${sql.lit(JSON.stringify(previousRecipe))}::jsonb`),
    )
    .alterColumn("recipe_sha256", (column) => column.setDefault(previousRecipeSha256))
    .execute();
}
