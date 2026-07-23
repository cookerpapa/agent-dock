import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downParallelCandidateRaces,
  migrationProvider,
  upParallelCandidateRaces,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const IDS = {
  tenant: "11000000-0000-4000-8000-000000000001",
  user: "12000000-0000-4000-8000-000000000001",
  project: "13000000-0000-4000-8000-000000000001",
  workspace: "14000000-0000-4000-8000-000000000001",
  credential: "15000000-0000-4000-8000-000000000001",
  profile: "16000000-0000-4000-8000-000000000001",
  environment: "17000000-0000-4000-8000-000000000001",
  parentSession: "18000000-0000-4000-8000-000000000001",
  childSession: "18000000-0000-4000-8000-000000000002",
  piArtifact: "19000000-0000-4000-8000-000000000001",
  workspaceArtifact: "19000000-0000-4000-8000-000000000002",
  baseVersion: "1a000000-0000-4000-8000-000000000001",
  promotedVersion: "1a000000-0000-4000-8000-000000000002",
  turn: "1b000000-0000-4000-8000-000000000001",
  command: "1c000000-0000-4000-8000-000000000001",
  run: "1d000000-0000-4000-8000-000000000001",
  orchestration: "1e000000-0000-4000-8000-000000000001",
  candidate: "1f000000-0000-4000-8000-000000000001",
} as const;

async function fixture(): Promise<PGlite> {
  const postgres = await PGlite.create();
  const migrations = await migrationProvider.getMigrations();
  for (const [name, migration] of Object.entries(migrations).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (name.localeCompare("021_parallel_candidate_races") >= 0) continue;
    await applyCompiledQueries(postgres, await compileMigration(migration.up));
  }
  await postgres.query("insert into tenants (id, slug) values ($1, 'race-owner')", [IDS.tenant]);
  await postgres.query(
    "insert into users (id, tenant_id, display_name) values ($1, $2, 'Race Owner')",
    [IDS.user, IDS.tenant],
  );
  await postgres.query(
    `insert into credential_bindings
       (id, tenant_id, provider, kind, secret_ref, version, status)
     values ($1, $2, 'agent-dock-fake', 'brokered', 'test://race', 1, 'active')`,
    [IDS.credential, IDS.tenant],
  );
  await postgres.query(
    `insert into model_profiles
       (id, tenant_id, name, provider, model_id, default_thinking_level,
        allowed_thinking_levels, credential_binding_id, credential_binding_version)
     values ($1, $2, 'race', 'agent-dock-fake', 'agent-dock-fake', 'off',
             array['off'], $3, 1)`,
    [IDS.profile, IDS.tenant, IDS.credential],
  );
  await postgres.query(
    `insert into tenant_runtime_policies
       (tenant_id, default_model_profile_id, maximum_projects, maximum_sessions,
        maximum_unsettled_turns, maximum_concurrent_turns)
     values ($1, $2, 10, 10, 10, 2)`,
    [IDS.tenant, IDS.profile],
  );
  await postgres.query("insert into projects (id, tenant_id, name) values ($1, $2, 'Race')", [
    IDS.project,
    IDS.tenant,
  ]);
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
    `insert into environment_versions
       (id, tenant_id, project_id, version_number, profile_key, profile_version,
        image_revision, spec_sha256, recipe, recipe_sha256, state, active, validated_at)
     values ($1, $2, $3, 1, 'agent-dock-fullstack', '1', 'test',
             $4,
             '{"schemaVersion":1,"setupCommands":[],"verificationCommands":[{"id":"git-worktree","command":"git status --short","cwd":".","timeoutMs":10000,"network":"none"}]}'::jsonb,
             $5, 'validated', true, now())`,
    [
      IDS.environment,
      IDS.tenant,
      IDS.project,
      "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      "5a851a442529ef2a092e5fb4f8f217703766a0142b267e4beb14fb1201aa1b6d",
    ],
  );
  await postgres.query(
    `insert into sessions
       (id, tenant_id, project_id, workspace_id, desired_model_profile_id, state)
     values ($1, $2, $3, $4, $5, 'idle'),
            ($6, $2, $3, $4, $5, 'cold')`,
    [IDS.parentSession, IDS.tenant, IDS.project, IDS.workspace, IDS.profile, IDS.childSession],
  );
  await postgres.query(
    `insert into artifacts
       (id, tenant_id, session_id, turn_id, kind, object_key, sha256, size_bytes)
     values ($1, $3, $4, null, 'pi_session_snapshot', 'pi/base', $5, 1),
            ($2, $3, $4, null, 'workspace_snapshot', 'workspace/base', $5, 1)`,
    [IDS.piArtifact, IDS.workspaceArtifact, IDS.tenant, IDS.parentSession, "b".repeat(64)],
  );
  await postgres.query(
    `insert into workspace_versions
       (id, tenant_id, workspace_id, session_id, version_number, origin_kind,
        pi_artifact_id, workspace_artifact_id, revision, state, settled_at)
     values ($1, $2, $3, $4, 1, 'migration', $5, $6, $7, 'settled', now())`,
    [
      IDS.baseVersion,
      IDS.tenant,
      IDS.workspace,
      IDS.parentSession,
      IDS.piArtifact,
      IDS.workspaceArtifact,
      "c".repeat(64),
    ],
  );
  await postgres.query("update sessions set current_workspace_version_id = $1 where id = $2", [
    IDS.baseVersion,
    IDS.parentSession,
  ]);
  await postgres.query(
    `insert into turns
       (id, tenant_id, session_id, state, input_kind, input_text, model_profile_id,
        provider, model_id, thinking_level, credential_binding_id,
        credential_binding_version)
     values ($1, $2, $3, 'queued', 'prompt', 'candidate', $4,
             'agent-dock-fake', 'agent-dock-fake', 'off', $5, 1)`,
    [IDS.turn, IDS.tenant, IDS.childSession, IDS.profile, IDS.credential],
  );
  await postgres.query(
    `insert into commands
       (id, tenant_id, session_id, turn_id, idempotency_key, kind, state,
        mailbox_position, payload)
     values ($1, $2, $3, $4, 'candidate', 'turn.execute', 'pending', 1,
             jsonb_build_object('schemaVersion', 1, 'requestHash', $5::text))`,
    [IDS.command, IDS.tenant, IDS.childSession, IDS.turn, "d".repeat(64)],
  );
  await postgres.query(
    `insert into runs
       (id, tenant_id, project_id, workspace_id, session_id, turn_id, command_id,
        environment_version_id, source_set_snapshot, idempotency_key, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8,
             '{"schemaVersion":1,"entries":[{"root":".","kind":"sample_java"}]}'::jsonb,
             'candidate', 'queued')`,
    [
      IDS.run,
      IDS.tenant,
      IDS.project,
      IDS.workspace,
      IDS.childSession,
      IDS.turn,
      IDS.command,
      IDS.environment,
    ],
  );
  return postgres;
}

describe("parallel candidate race migration", () => {
  it("creates tenant-bound races, immutable acceptance, and promotion history", async () => {
    const postgres = await fixture();
    try {
      await applyCompiledQueries(postgres, await compileMigration(upParallelCandidateRaces));
      await postgres.query(
        `insert into orchestration_runs
           (id, tenant_id, project_id, workspace_id, parent_session_id,
            base_workspace_version_id, prompt, candidate_specs, acceptance_policy,
            candidate_count, maximum_concurrent_candidates, created_by_user_id,
            idempotency_key, request_fingerprint)
         values ($1, $2, $3, $4, $5, $6, 'repair',
                 '{"schemaVersion":1}'::jsonb, '{}'::jsonb, 2, 1, $7, 'race-1', $8)`,
        [
          IDS.orchestration,
          IDS.tenant,
          IDS.project,
          IDS.workspace,
          IDS.parentSession,
          IDS.baseVersion,
          IDS.user,
          "e".repeat(64),
        ],
      );
      await postgres.query(
        `insert into orchestration_candidates
           (id, tenant_id, orchestration_id, ordinal, label, strategy,
            child_session_id, run_id)
         values ($1, $2, $3, 1, 'Minimal', 'small patch', $4, $5)`,
        [IDS.candidate, IDS.tenant, IDS.orchestration, IDS.childSession, IDS.run],
      );
      await postgres.query(
        `insert into orchestration_acceptance_results
           (candidate_id, tenant_id, orchestration_id, verdict, workspace_version_id, scorecard)
         values ($1, $2, $3, 'failed', $4, '{"reasons":["run_failed"]}'::jsonb)`,
        [IDS.candidate, IDS.tenant, IDS.orchestration, IDS.baseVersion],
      );
      await expect(
        postgres.query(
          "update orchestration_acceptance_results set verdict = 'passed' where candidate_id = $1",
          [IDS.candidate],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        postgres.query(
          `insert into orchestration_runs
             (id, tenant_id, project_id, workspace_id, parent_session_id,
              base_workspace_version_id, prompt, candidate_specs, acceptance_policy,
              candidate_count, maximum_concurrent_candidates, created_by_user_id,
              idempotency_key, request_fingerprint)
           values ($1, $2, $3, $4, $5, $6, 'invalid',
                   '{}'::jsonb, '{}'::jsonb, 2, 3, $7, 'race-invalid', $8)`,
          [
            "2e000000-0000-4000-8000-000000000002",
            IDS.tenant,
            IDS.project,
            IDS.workspace,
            IDS.parentSession,
            IDS.baseVersion,
            IDS.user,
            "f".repeat(64),
          ],
        ),
      ).rejects.toThrow();
      await postgres.query(
        `insert into workspace_versions
           (id, tenant_id, workspace_id, session_id, version_number, parent_version_id,
            source_version_id, origin_kind, pi_artifact_id, workspace_artifact_id,
            revision, state, settled_at)
         values ($1, $2, $3, $4, 2, $5, $5, 'promotion', $6, $7, $8, 'settled', now())`,
        [
          IDS.promotedVersion,
          IDS.tenant,
          IDS.workspace,
          IDS.parentSession,
          IDS.baseVersion,
          IDS.piArtifact,
          IDS.workspaceArtifact,
          "1".repeat(64),
        ],
      );
      await postgres.query("delete from workspace_versions where id = $1", [IDS.promotedVersion]);
      await applyCompiledQueries(postgres, await compileMigration(downParallelCandidateRaces));
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name like 'orchestration_%'`,
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 45_000);
});
