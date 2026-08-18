import { sql, type Kysely } from "kysely";

const validTools = (column: string, minimum: 0 | 1) => sql`
  jsonb_typeof(${sql.ref(column)}) = 'array'
  and jsonb_array_length(${sql.ref(column)}) between ${sql.raw(String(minimum))} and 4
  and ${sql.ref(column)} <@ '["read","write","edit","bash"]'::jsonb
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_tool_capabilities_valid")
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint("sessions_tool_capabilities_valid", validTools("tool_capabilities", 0))
    .execute();
  await db.schema
    .alterTable("runs")
    .dropConstraint("runs_tool_capability_snapshot_valid")
    .execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_tool_capability_snapshot_valid",
      validTools("tool_capability_snapshot", 0),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const fallback = sql`'["read","write","edit","bash"]'::jsonb`;
  await sql`update sessions set tool_capabilities = ${fallback} where jsonb_array_length(tool_capabilities) = 0`.execute(
    db,
  );
  await sql`update runs set tool_capability_snapshot = ${fallback} where jsonb_array_length(tool_capability_snapshot) = 0`.execute(
    db,
  );
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_tool_capabilities_valid")
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint("sessions_tool_capabilities_valid", validTools("tool_capabilities", 1))
    .execute();
  await db.schema
    .alterTable("runs")
    .dropConstraint("runs_tool_capability_snapshot_valid")
    .execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_tool_capability_snapshot_valid",
      validTools("tool_capability_snapshot", 1),
    )
    .execute();
}
