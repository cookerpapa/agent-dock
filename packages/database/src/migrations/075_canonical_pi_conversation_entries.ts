import { sql, type Kysely } from "kysely";

/**
 * Make Pi SessionStorage the only long-lived owner of complete conversation
 * messages. The product Turn is attached to each newly appended Pi entry;
 * The bounded PostgreSQL hot tail remains independent and no second complete
 * transcript body is retained.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("pi_session_entries").addColumn("turn_id", "uuid").execute();
  await db.schema.alterTable("pi_session_records").addColumn("turn_id", "uuid").execute();

  // Existing development data predates the explicit Turn binding. Associate
  // entries with the most recently accepted Turn in the same Session. This is
  // a one-time data migration, not a runtime compatibility path.
  await sql`
    update pi_session_entries as entry
       set turn_id = (
         select turn_row.id
           from turns as turn_row
          where turn_row.tenant_id = entry.tenant_id
            and turn_row.session_id::text = entry.session_id
            and turn_row.created_at <= to_timestamp(entry.timestamp_ms::double precision / 1000)
          order by turn_row.created_at desc, turn_row.id desc
          limit 1
       )
     where entry.turn_id is null
  `.execute(db);
  await sql`
    update pi_session_records as record
       set turn_id = (
         select turn_row.id
           from turns as turn_row
          where turn_row.tenant_id = record.tenant_id
            and turn_row.session_id::text = record.session_id
            and turn_row.created_at <= to_timestamp(record.timestamp_ms::double precision / 1000)
          order by turn_row.created_at desc, turn_row.id desc
          limit 1
       )
     where record.turn_id is null
  `.execute(db);

  await db.schema
    .alterTable("pi_session_entries")
    .addForeignKeyConstraint(
      "pi_session_entries_turn_fk",
      ["turn_id"],
      "turns",
      ["id"],
      (constraint) => constraint.onDelete("set null"),
    )
    .execute();
  await db.schema
    .alterTable("pi_session_records")
    .addForeignKeyConstraint(
      "pi_session_records_turn_fk",
      ["turn_id"],
      "turns",
      ["id"],
      (constraint) => constraint.onDelete("set null"),
    )
    .execute();

  // Pi's ordered log keeps stable references; entry/record bodies remain in
  // their canonical tables and are hydrated on read.
  await sql`
    update pi_session_log
       set payload = jsonb_build_object('entryId', payload #>> '{entry,id}')
     where kind = 'entry'
  `.execute(db);
  await sql`
    update pi_session_log
       set payload = jsonb_build_object('recordId', payload #>> '{record,id}')
     where kind = 'record'
  `.execute(db);
  await db.schema
    .createIndex("pi_session_entries_turn_query")
    .on("pi_session_entries")
    .columns(["tenant_id", "turn_id", "seq"])
    .where("turn_id", "is not", null)
    .execute();
  await db.schema
    .createIndex("pi_session_records_turn_query")
    .on("pi_session_records")
    .columns(["tenant_id", "turn_id", "seq"])
    .where("turn_id", "is not", null)
    .execute();

  await db.schema.dropTable("conversation_turn_projections").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update pi_session_log as log
       set payload = jsonb_build_object('entry', entry.payload)
      from pi_session_entries as entry
     where log.kind = 'entry'
       and entry.tenant_id = log.tenant_id
       and entry.session_id = log.session_id
       and entry.id = log.payload ->> 'entryId'
  `.execute(db);
  await sql`
    update pi_session_log as log
       set payload = jsonb_build_object('record', record.payload)
      from pi_session_records as record
     where log.kind = 'record'
       and record.tenant_id = log.tenant_id
       and record.session_id = log.session_id
       and record.id = log.payload ->> 'recordId'
  `.execute(db);
  await db.schema
    .createTable("conversation_turn_projections")
    .addColumn("turn_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("schema_version", "integer", (column) => column.notNull().defaultTo(1))
    .addColumn("through_seq", "bigint", (column) => column.notNull())
    .addColumn("source_event_count", "integer", (column) => column.notNull())
    .addColumn("transcript", "jsonb", (column) => column.notNull())
    .addColumn("projected_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.dropIndex("pi_session_entries_turn_query").execute();
  await db.schema.dropIndex("pi_session_records_turn_query").execute();
  await db.schema
    .alterTable("pi_session_entries")
    .dropConstraint("pi_session_entries_turn_fk")
    .execute();
  await db.schema
    .alterTable("pi_session_records")
    .dropConstraint("pi_session_records_turn_fk")
    .execute();
  await db.schema.alterTable("pi_session_entries").dropColumn("turn_id").execute();
  await db.schema.alterTable("pi_session_records").dropColumn("turn_id").execute();
}
