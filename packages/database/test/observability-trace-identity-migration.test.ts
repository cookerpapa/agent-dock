import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downObservabilityTraceIdentity,
  upContextAndModelGovernance,
  upControlledWorkspaceSources,
  upDurableEventDelivery,
  upDurableRunsAndAttempts,
  upEncryptedTenantModelCredentials,
  upExplicitSessionMailbox,
  upInitialControlPlane,
  upObservabilityTraceIdentity,
  upPrivateMultiTenantIdentity,
  upSupervisorBootCredentials,
  upSupervisorConnectionHealth,
  upVersionedWorkspacesAndGitHubDelivery,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

async function fixture(): Promise<PGlite> {
  const postgres = await PGlite.create();
  for (const migration of [
    upInitialControlPlane,
    upDurableEventDelivery,
    upExplicitSessionMailbox,
    upSupervisorConnectionHealth,
    upSupervisorBootCredentials,
    upPrivateMultiTenantIdentity,
    upEncryptedTenantModelCredentials,
    upControlledWorkspaceSources,
    upDurableRunsAndAttempts,
    upVersionedWorkspacesAndGitHubDelivery,
    upContextAndModelGovernance,
    upObservabilityTraceIdentity,
  ]) {
    await applyCompiledQueries(postgres, await compileMigration(migration));
  }
  return postgres;
}

describe("observability trace identity migration", () => {
  it("adds a constrained tenant-scoped Run trace identity", async () => {
    const postgres = await fixture();
    try {
      const column = await postgres.query<{ is_nullable: string; column_default: string | null }>(
        `select is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public' and table_name = 'runs' and column_name = 'trace_id'`,
      );
      expect(column.rows).toHaveLength(1);
      expect(column.rows[0]?.is_nullable).toBe("NO");
      expect(column.rows[0]?.column_default).toContain("md5");

      const constraints = await postgres.query<{ constraint_name: string }>(
        `select constraint_name from information_schema.table_constraints
          where table_schema = 'public' and table_name = 'runs'
            and constraint_name = 'runs_trace_id_valid'`,
      );
      expect(constraints.rows).toEqual([{ constraint_name: "runs_trace_id_valid" }]);
    } finally {
      await postgres.close();
    }
  }, 30_000);

  it("rolls back without removing durable Runs", async () => {
    const postgres = await fixture();
    try {
      await applyCompiledQueries(postgres, await compileMigration(downObservabilityTraceIdentity));
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name = 'runs'`,
      );
      const columns = await postgres.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'runs' and column_name = 'trace_id'`,
      );
      expect(tables.rows).toEqual([{ table_name: "runs" }]);
      expect(columns.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
