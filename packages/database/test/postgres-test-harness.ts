import { PGlite } from "@electric-sql/pglite";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Dialect,
} from "kysely";

function createPostgresCompilationDialect(): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

export async function compileMigration<TDatabase = unknown>(
  migration: (db: Kysely<TDatabase>) => Promise<void>,
): Promise<readonly CompiledQuery[]> {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<TDatabase>({
    dialect: createPostgresCompilationDialect(),
    log(event) {
      if (event.level === "query") {
        queries.push(event.query);
      }
    },
  });
  try {
    await migration(db);
    return queries;
  } finally {
    await db.destroy();
  }
}

export async function applyCompiledQueries(
  postgres: PGlite,
  queries: readonly CompiledQuery[],
): Promise<void> {
  for (const query of queries) {
    await postgres.query(query.sql, [...query.parameters]);
  }
}
