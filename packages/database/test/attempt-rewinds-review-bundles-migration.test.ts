import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downAttemptRewindsAndReviewBundles,
  migrationProvider,
  upAttemptRewindsAndReviewBundles,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  user: "11000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  workspace: "30000000-0000-4000-8000-000000000001",
  credential: "40000000-0000-4000-8000-000000000001",
  profile: "50000000-0000-4000-8000-000000000001",
  session: "60000000-0000-4000-8000-000000000001",
  turn: "70000000-0000-4000-8000-000000000001",
  command: "80000000-0000-4000-8000-000000000001",
  run: "90000000-0000-4000-8000-000000000001",
  attempt: "a0000000-0000-4000-8000-000000000001",
  bundle: "b0000000-0000-4000-8000-000000000001",
} as const;

async function fixture(): Promise<PGlite> {
  const postgres = await PGlite.create();
  const migrations = await migrationProvider.getMigrations();
  for (const [name, migration] of Object.entries(migrations).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (name.localeCompare("018_attempt_rewinds_and_review_bundles") >= 0) continue;
    await applyCompiledQueries(postgres, await compileMigration(migration.up));
  }
  await postgres.query("insert into tenants (id, slug) values ($1, 'review-owner')", [IDS.tenant]);
  await postgres.query(
    "insert into users (id, tenant_id, display_name) values ($1, $2, 'Review Owner')",
    [IDS.user, IDS.tenant],
  );
  await postgres.query(
    "insert into projects (id, tenant_id, name) values ($1, $2, 'Review Project')",
    [IDS.project, IDS.tenant],
  );
  await postgres.query("insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)", [
    IDS.workspace,
    IDS.tenant,
    IDS.project,
  ]);
  await postgres.query(
    `insert into workspace_sources (tenant_id, workspace_id, kind, status)
     values ($1, $2, 'sample_java', 'ready')`,
    [IDS.tenant, IDS.workspace],
  );
  await postgres.query(
    `insert into credential_bindings
       (id, tenant_id, provider, kind, secret_ref, version, status)
     values ($1, $2, 'agent-dock-fake', 'brokered', 'fixture', 1, 'active')`,
    [IDS.credential, IDS.tenant],
  );
  await postgres.query(
    `insert into model_profiles
       (id, tenant_id, name, provider, model_id, default_thinking_level,
        allowed_thinking_levels, credential_binding_id, credential_binding_version)
     values ($1, $2, 'default', 'agent-dock-fake', 'agent-dock-fake', 'off',
             array['off'], $3, 1)`,
    [IDS.profile, IDS.tenant, IDS.credential],
  );
  await postgres.query(
    `insert into environment_versions
       (id, tenant_id, project_id, version_number, profile_key, profile_version,
        image_revision, spec_sha256, state, active)
     values ($1, $2, $1, 1, 'agent-dock-fullstack', '1', 'test',
             'e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630',
             'pending', true)`,
    [IDS.project, IDS.tenant],
  );
  await postgres.query(
    `insert into sessions
       (id, tenant_id, project_id, workspace_id, desired_model_profile_id, state)
     values ($1, $2, $3, $4, $5, 'idle')`,
    [IDS.session, IDS.tenant, IDS.project, IDS.workspace, IDS.profile],
  );
  await postgres.query(
    `insert into turns
       (id, tenant_id, session_id, state, input_kind, input_text, model_profile_id,
        provider, model_id, thinking_level, credential_binding_id,
        credential_binding_version, stop_reason, started_at, settled_at)
     values ($1, $2, $3, 'completed', 'prompt', 'review me', $4,
             'agent-dock-fake', 'agent-dock-fake', 'off', $5, 1,
             'stop', now() - interval '1 second', now())`,
    [IDS.turn, IDS.tenant, IDS.session, IDS.profile, IDS.credential],
  );
  await postgres.query(
    `insert into commands
       (id, tenant_id, session_id, turn_id, idempotency_key, kind, state, payload,
        mailbox_position, dispatched_at, acknowledged_at, completed_at)
     values ($1, $2, $3, $4, 'review-run', 'turn.execute', 'completed',
             jsonb_build_object('schemaVersion', 1, 'requestHash', $5::text), 1,
             now(), now(), now())`,
    [IDS.command, IDS.tenant, IDS.session, IDS.turn, "a".repeat(64)],
  );
  await postgres.query(
    `insert into runs
       (id, tenant_id, project_id, workspace_id, session_id, turn_id, command_id,
        environment_version_id, source_set_snapshot, idempotency_key, state)
     values ($1, $2, $3, $4, $5, $6, $7, $3,
             '{"schemaVersion":1,"entries":[{"root":".","kind":"sample_java"}]}'::jsonb,
             'review-run', 'queued')`,
    [IDS.run, IDS.tenant, IDS.project, IDS.workspace, IDS.session, IDS.turn, IDS.command],
  );
  await postgres.query(
    `insert into run_attempts
       (id, tenant_id, run_id, attempt_number, state, claim_owner_id,
        claim_expires_at, settled_at)
     values ($1, $2, $3, 1, 'completed', 'worker', now() + interval '1 minute', now())`,
    [IDS.attempt, IDS.tenant, IDS.run],
  );
  await postgres.query(
    `update runs set state = 'completed', current_attempt_id = $1, attempt_count = 1,
       stop_reason = 'stop', started_at = now() - interval '1 second', settled_at = now()
     where id = $2`,
    [IDS.attempt, IDS.run],
  );
  return postgres;
}

describe("attempt rewind and Review Bundle migration", () => {
  it("captures explicit bases and makes Review Bundles append-only", async () => {
    const postgres = await fixture();
    try {
      await applyCompiledQueries(
        postgres,
        await compileMigration(upAttemptRewindsAndReviewBundles),
      );
      const run = await postgres.query<{
        conversation_base_seq: number;
        workspace_base_version_id: string | null;
        pi_session_base_artifact_id: string | null;
      }>(
        `select conversation_base_seq, workspace_base_version_id, pi_session_base_artifact_id
           from runs where id = $1`,
        [IDS.run],
      );
      expect(run.rows).toEqual([
        {
          conversation_base_seq: 0,
          workspace_base_version_id: null,
          pi_session_base_artifact_id: null,
        },
      ]);
      await postgres.query(
        `insert into review_bundles
          (id, tenant_id, project_id, workspace_id, session_id, run_id, attempt_id,
           manifest, manifest_sha256)
         values ($1, $2, $3, $4, $5, $6, $7, '{"schemaVersion":1}'::jsonb, $8)`,
        [
          IDS.bundle,
          IDS.tenant,
          IDS.project,
          IDS.workspace,
          IDS.session,
          IDS.run,
          IDS.attempt,
          "b".repeat(64),
        ],
      );
      await expect(
        postgres.query("update review_bundles set manifest = '{}'::jsonb where id = $1", [
          IDS.bundle,
        ]),
      ).rejects.toThrow(/immutable/);
      await expect(
        postgres.query("delete from review_bundles where id = $1", [IDS.bundle]),
      ).rejects.toThrow(/immutable/);

      await applyCompiledQueries(
        postgres,
        await compileMigration(downAttemptRewindsAndReviewBundles),
      );
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('run_rewinds', 'review_bundles')`,
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 45_000);
});
