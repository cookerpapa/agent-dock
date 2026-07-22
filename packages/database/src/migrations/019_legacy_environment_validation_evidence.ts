import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("environment_validation_evidence_backfills")
    .addColumn("environment_validation_id", "uuid", (column) => column.primaryKey())
    .addColumn("original_report", "jsonb", (column) => column.notNull())
    .addColumn("backfilled_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "environment_validation_evidence_backfills_validation_fk",
      ["environment_validation_id"],
      "environment_validations",
      ["id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .execute();

  await sql`
    insert into environment_validation_evidence_backfills
      (environment_validation_id, original_report)
    select id, report
      from environment_validations
     where status = 'validated'
       and jsonb_typeof(report) = 'object'
       and (not report ? 'recipeSha256' or not report ? 'recipeCommands')
  `.execute(db);

  await sql`
    update environment_validations as validation
       set report = validation.report || jsonb_build_object(
         'recipeSha256', coalesce(
           validation.report -> 'recipeSha256',
           to_jsonb(environment.recipe_sha256)
         ),
         'recipeCommands', coalesce(
           validation.report -> 'recipeCommands',
           '[]'::jsonb
         )
       )
      from environment_versions as environment,
           environment_validation_evidence_backfills as backfill
     where validation.id = backfill.environment_validation_id
       and environment.tenant_id = validation.tenant_id
       and environment.project_id = validation.project_id
       and environment.id = validation.environment_version_id
  `.execute(db);

  await db.schema
    .alterTable("environment_validations")
    .addCheckConstraint(
      "environment_validations_recipe_evidence_shape",
      sql`status <> 'validated' or (
        jsonb_typeof(report) = 'object'
        and report ? 'recipeSha256'
        and report ? 'recipeCommands'
        and coalesce((report ->> 'recipeSha256') ~ '^[0-9a-f]{64}$', false)
        and jsonb_typeof(report -> 'recipeCommands') = 'array'
      )`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("environment_validations")
    .dropConstraint("environment_validations_recipe_evidence_shape")
    .execute();

  await sql`
    update environment_validations as validation
       set report = backfill.original_report
      from environment_validation_evidence_backfills as backfill
     where validation.id = backfill.environment_validation_id
  `.execute(db);

  await db.schema.dropTable("environment_validation_evidence_backfills").execute();
}
