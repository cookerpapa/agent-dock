import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./database-types.ts";

export type CreateDatabaseOptions = {
  connectionString: string;
  maxConnections?: number;
};

export function createDatabase(options: CreateDatabaseOptions): Kysely<Database> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("connectionString must not be empty");
  }
  const maxConnections = options.maxConnections ?? 10;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new Error("maxConnections must be a positive safe integer");
  }
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: options.connectionString,
        max: maxConnections,
      }),
    }),
  });
}
