import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downPiCloudEnvironmentProfile, upPiCloudEnvironmentProfile } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("Pi Cloud environment profile cutover", () => {
  it("updates an installed AgentDock profile constraint and validation evidence", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table environment_versions (
          id uuid primary key,
          profile_key text not null,
          updated_at timestamptz not null default now(),
          constraint environment_versions_profile_key_valid
            check (profile_key = 'agent-dock-fullstack')
        );
        create table environment_validations (
          id uuid primary key,
          report jsonb
        );
        insert into environment_versions (id, profile_key)
        values ('00000000-0000-4000-8000-000000000001', 'agent-dock-fullstack');
        insert into environment_validations (id, report)
        values (
          '00000000-0000-4000-8000-000000000002',
          '{"profileKey":"agent-dock-fullstack","runtime":"cubesandbox-kvm"}'::jsonb
        );
      `);

      await applyCompiledQueries(postgres, await compileMigration(upPiCloudEnvironmentProfile));

      const upgraded = await postgres.query<{ profile_key: string }>(
        "select profile_key from environment_versions",
      );
      expect(upgraded.rows).toEqual([{ profile_key: "pi-cloud-fullstack" }]);
      const evidence = await postgres.query<{ profile_key: string }>(
        "select report ->> 'profileKey' as profile_key from environment_validations",
      );
      expect(evidence.rows).toEqual([{ profile_key: "pi-cloud-fullstack" }]);
      await expect(
        postgres.exec(`
          insert into environment_versions (id, profile_key)
          values ('00000000-0000-4000-8000-000000000003', 'agent-dock-fullstack')
        `),
      ).rejects.toThrow();

      await applyCompiledQueries(postgres, await compileMigration(downPiCloudEnvironmentProfile));
      const restored = await postgres.query<{ profile_key: string }>(
        "select profile_key from environment_versions",
      );
      expect(restored.rows).toEqual([{ profile_key: "agent-dock-fullstack" }]);
    } finally {
      await postgres.close();
    }
  });
});
