import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downLegacyEnvironmentValidationEvidence,
  upLegacyEnvironmentValidationEvidence,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const RECIPE_SHA256 = "5a851a442529ef2a092e5fb4f8f217703766a0142b267e4beb14fb1201aa1b6d";

const LEGACY_REPORT = {
  profileKey: "agent-dock-fullstack",
  profileVersion: "1",
  imageRevision: "legacy",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
  isolationBoundary: "gvisor",
  runtime: "runsc",
  networkMode: "deny_all",
  runAsUser: "1000:1000",
  readOnlyRootFilesystem: true,
  tools: [
    { name: "node", version: "v24.18.0" },
    { name: "java", version: 'openjdk version "17.0.19"' },
    { name: "python", version: "Python 3.11.2" },
    { name: "git", version: "git version 2.39.5" },
  ],
};

describe("legacy environment validation evidence migration", () => {
  it("normalizes old reports, guards future writes, and restores exact evidence on rollback", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table environment_versions (
          id uuid primary key,
          tenant_id uuid not null,
          project_id uuid not null,
          recipe_sha256 text not null
        );
        create table environment_validations (
          id uuid primary key,
          tenant_id uuid not null,
          project_id uuid not null,
          environment_version_id uuid not null,
          status text not null,
          report jsonb
        );
      `);
      const tenant = "10000000-0000-4000-8000-000000000001";
      const project = "20000000-0000-4000-8000-000000000001";
      const legacyValidation = "30000000-0000-4000-8000-000000000001";
      const currentValidation = "30000000-0000-4000-8000-000000000002";
      await postgres.query(
        `insert into environment_versions (id, tenant_id, project_id, recipe_sha256)
         values ($1, $2, $1, $3)`,
        [project, tenant, RECIPE_SHA256],
      );
      await postgres.query(
        `insert into environment_validations
          (id, tenant_id, project_id, environment_version_id, status, report)
         values ($1, $2, $3, $3, 'validated', $4),
                ($5, $2, $3, $3, 'validated', $6)`,
        [
          legacyValidation,
          tenant,
          project,
          JSON.stringify(LEGACY_REPORT),
          currentValidation,
          JSON.stringify({
            ...LEGACY_REPORT,
            recipeSha256: RECIPE_SHA256,
            recipeCommands: [],
          }),
        ],
      );

      await applyCompiledQueries(
        postgres,
        await compileMigration(upLegacyEnvironmentValidationEvidence),
      );

      const reports = await postgres.query<{ id: string; report: Record<string, unknown> }>(
        "select id, report from environment_validations order by id",
      );
      expect(reports.rows).toEqual([
        {
          id: legacyValidation,
          report: { ...LEGACY_REPORT, recipeSha256: RECIPE_SHA256, recipeCommands: [] },
        },
        {
          id: currentValidation,
          report: { ...LEGACY_REPORT, recipeSha256: RECIPE_SHA256, recipeCommands: [] },
        },
      ]);
      const backfills = await postgres.query<{ environment_validation_id: string }>(
        "select environment_validation_id from environment_validation_evidence_backfills",
      );
      expect(backfills.rows).toEqual([{ environment_validation_id: legacyValidation }]);
      await expect(
        postgres.query(
          `insert into environment_validations
            (id, tenant_id, project_id, environment_version_id, status, report)
           values ('30000000-0000-4000-8000-000000000003', $1, $2, $2, 'validated', $3)`,
          [tenant, project, JSON.stringify(LEGACY_REPORT)],
        ),
      ).rejects.toThrow();

      await applyCompiledQueries(
        postgres,
        await compileMigration(downLegacyEnvironmentValidationEvidence),
      );
      const restored = await postgres.query<{ report: Record<string, unknown> }>(
        "select report from environment_validations where id = $1",
        [legacyValidation],
      );
      expect(restored.rows).toEqual([{ report: LEGACY_REPORT }]);
      const ledger = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name = 'environment_validation_evidence_backfills'`,
      );
      expect(ledger.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 30_000);
});
