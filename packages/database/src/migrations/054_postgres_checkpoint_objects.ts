import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../database-types.ts";

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    create table checkpoint_objects (
      object_key text primary key,
      bytes bytea not null,
      sha256 text not null,
      size_bytes bigint not null,
      created_at timestamptz not null default now(),
      constraint checkpoint_objects_key_valid check (length(object_key) between 1 and 2048),
      constraint checkpoint_objects_sha_valid check (sha256 ~ '^[a-f0-9]{64}$'),
      constraint checkpoint_objects_size_valid check (size_bytes between 1 and 142606336)
    )
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`drop table checkpoint_objects`.execute(db);
}
