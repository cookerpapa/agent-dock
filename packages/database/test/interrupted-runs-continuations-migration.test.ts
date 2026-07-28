import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  downInterruptedRunsAndContinuations,
  runMigrations,
  upInterruptedRunsAndContinuations,
} from "../src/index.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe("interrupted Run and continuation migration", () => {
  it("adds a durable continuation link and terminal interrupted constraints", async () => {
    const column = await pglite.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'runs'
        and column_name = 'continued_from_run_id'
    `);
    expect(column.rows).toEqual([
      {
        column_name: "continued_from_run_id",
        data_type: "uuid",
        is_nullable: "YES",
      },
    ]);

    const constraints = await pglite.query<{
      conname: string;
      definition: string;
    }>(`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'turns_state_valid',
        'runs_state_valid',
        'run_attempts_state_valid',
        'runs_continued_from_run_fk',
        'runs_one_continuation_per_source_unique'
      )
      order by conname
    `);
    expect(constraints.rows).toHaveLength(5);
    expect(
      constraints.rows
        .filter((constraint) => constraint.conname.endsWith("_state_valid"))
        .every((constraint) => constraint.definition.includes("interrupted")),
    ).toBe(true);
    expect(
      constraints.rows.find((constraint) => constraint.conname === "runs_continued_from_run_fk")
        ?.definition,
    ).toContain("FOREIGN KEY");
    expect(
      constraints.rows.find(
        (constraint) => constraint.conname === "runs_one_continuation_per_source_unique",
      )?.definition,
    ).toContain("UNIQUE");

    const migrationDatabase = database as unknown as Kysely<unknown>;
    await downInterruptedRunsAndContinuations(migrationDatabase);
    expect(
      (
        await pglite.query(`
          select column_name
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'runs'
            and column_name = 'continued_from_run_id'
        `)
      ).rows,
    ).toEqual([]);
    await upInterruptedRunsAndContinuations(migrationDatabase);
  });
});
