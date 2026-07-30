import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("commands").dropConstraint("commands_kind_valid").execute();
  await db.schema
    .alterTable("commands")
    .addCheckConstraint(
      "commands_kind_valid",
      sql`kind in ('turn.execute', 'turn.cancel', 'turn.steer', 'approval.resolve')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from commands where kind = 'turn.steer'`.execute(db);
  await db.schema.alterTable("commands").dropConstraint("commands_kind_valid").execute();
  await db.schema
    .alterTable("commands")
    .addCheckConstraint(
      "commands_kind_valid",
      sql`kind in ('turn.execute', 'turn.cancel', 'approval.resolve')`,
    )
    .execute();
}
