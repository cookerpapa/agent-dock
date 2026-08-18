import { sql, type Kysely } from "kysely";

const defaultTools = sql`'["read","write","edit","bash"]'::jsonb`;
const validTools = (column: string) => sql`
  jsonb_typeof(${sql.ref(column)}) = 'array'
  and jsonb_array_length(${sql.ref(column)}) between 1 and 4
  and ${sql.ref(column)} <@ '["read","write","edit","bash"]'::jsonb
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("tool_capabilities", "jsonb", (column) => column.notNull().defaultTo(defaultTools))
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint("sessions_tool_capabilities_valid", validTools("tool_capabilities"))
    .execute();

  await db.schema
    .alterTable("runs")
    .addColumn("tool_capability_snapshot", "jsonb", (column) =>
      column.notNull().defaultTo(defaultTools),
    )
    .execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_tool_capability_snapshot_valid",
      validTools("tool_capability_snapshot"),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("runs").dropColumn("tool_capability_snapshot").execute();
  await db.schema.alterTable("sessions").dropColumn("tool_capabilities").execute();
}
