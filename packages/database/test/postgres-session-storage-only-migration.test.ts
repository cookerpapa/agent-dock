import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { describe, expect, it } from "vitest";
import { createDatabase, downPostgresSessionStorageOnly, runMigrations } from "../src/index.ts";
import { compileMigration } from "./postgres-test-harness.ts";

describe("PostgreSQL SessionStorage-only cutover", () => {
  it("removes synthetic Pi artifacts and JSONL-era pointer columns", async () => {
    const postgres = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: postgres, host: "127.0.0.1", port: 0 });
    let database: ReturnType<typeof createDatabase> | undefined;
    try {
      await socket.start();
      database = createDatabase({
        connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
        maxConnections: 1,
      });
      await runMigrations(database, "up");

      const removedColumns = await postgres.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public'
            and ((table_name = 'sessions' and column_name = 'pi_session_snapshot_key')
              or (table_name = 'runs' and column_name = 'pi_session_base_artifact_id')
              or (table_name = 'workspace_versions' and column_name = 'pi_artifact_id'))`,
      );
      expect(removedColumns.rows).toEqual([]);
      const artifactKinds = await postgres.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conname = 'artifacts_kind_valid'`,
      );
      expect(artifactKinds.rows[0]?.definition).not.toContain("pi_session_snapshot");
      await expect(compileMigration(downPostgresSessionStorageOnly)).rejects.toThrow(
        /intentional destructive cleanup/,
      );
    } finally {
      await database?.destroy();
      await socket.stop().catch(() => undefined);
      await postgres.close().catch(() => undefined);
    }
  }, 30_000);
});
