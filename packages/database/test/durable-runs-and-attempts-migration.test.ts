import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downDurableRunsAndAttempts,
  upDurableEventDelivery,
  upDurableRunsAndAttempts,
  upInitialControlPlane,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  workspace: "30000000-0000-4000-8000-000000000001",
  credential: "40000000-0000-4000-8000-000000000001",
  profile: "50000000-0000-4000-8000-000000000001",
  session: "60000000-0000-4000-8000-000000000001",
  turn: "70000000-0000-4000-8000-000000000001",
  command: "80000000-0000-4000-8000-000000000001",
  outbox: "90000000-0000-4000-8000-000000000001",
  run2: "a0000000-0000-4000-8000-000000000001",
  turn2: "a0000000-0000-4000-8000-000000000002",
  command2: "a0000000-0000-4000-8000-000000000003",
  attempt2: "a0000000-0000-4000-8000-000000000004",
} as const;

async function fixture(): Promise<PGlite> {
  const postgres = await PGlite.create();
  await applyCompiledQueries(postgres, await compileMigration(upInitialControlPlane));
  await applyCompiledQueries(postgres, await compileMigration(upDurableEventDelivery));
  await postgres.query("insert into tenants (id, slug) values ($1, 'runs-owner')", [IDS.tenant]);
  await postgres.query("insert into projects (id, tenant_id, name) values ($1, $2, 'Runs')", [
    IDS.project,
    IDS.tenant,
  ]);
  await postgres.query("insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)", [
    IDS.workspace,
    IDS.tenant,
    IDS.project,
  ]);
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
     values ($1, $2, $3, 'completed', 'prompt', 'repair', $4,
             'agent-dock-fake', 'agent-dock-fake', 'off', $5, 1,
             'stop', now() - interval '1 second', now())`,
    [IDS.turn, IDS.tenant, IDS.session, IDS.profile, IDS.credential],
  );
  await postgres.query(
    `insert into commands
       (id, tenant_id, session_id, turn_id, idempotency_key, kind, state, payload,
        dispatched_at, acknowledged_at, completed_at)
     values ($1::uuid, $2, $3, $4, 'run-request-1', 'turn.execute', 'completed',
             jsonb_build_object('commandId', ($1::uuid)::text), now(), now(), now())`,
    [IDS.command, IDS.tenant, IDS.session, IDS.turn],
  );
  await postgres.query(
    `insert into outbox
       (id, tenant_id, aggregate_type, aggregate_id, topic, payload, attempts, published_at)
     values ($1, $2, 'session', $3, 'turn.command.requested',
             jsonb_build_object('commandId', $4::text), 2, now())`,
    [IDS.outbox, IDS.tenant, IDS.session, IDS.command],
  );
  await applyCompiledQueries(postgres, await compileMigration(upDurableRunsAndAttempts));
  return postgres;
}

describe("durable runs and attempts migration", () => {
  it("backfills an explicit run, latest attempt and transition history", async () => {
    const postgres = await fixture();
    try {
      const run = await postgres.query<{
        id: string;
        state: string;
        attempt_count: number;
        current_attempt_id: string;
      }>("select id, state, attempt_count, current_attempt_id from runs where turn_id = $1", [
        IDS.turn,
      ]);
      expect(run.rows).toEqual([
        {
          id: IDS.turn,
          state: "completed",
          attempt_count: 2,
          current_attempt_id: IDS.turn,
        },
      ]);
      const attempt = await postgres.query<{ state: string; attempt_number: number }>(
        "select state, attempt_number from run_attempts where run_id = $1",
        [IDS.turn],
      );
      expect(attempt.rows).toEqual([{ state: "completed", attempt_number: 2 }]);
      const history = await postgres.query<{ from_state: string | null; to_state: string }>(
        "select from_state, to_state from run_attempt_transitions where run_id = $1",
        [IDS.turn],
      );
      expect(history.rows).toEqual([{ from_state: null, to_state: "completed" }]);
    } finally {
      await postgres.close();
    }
  }, 20_000);

  it("enforces attempt ownership, settlement shape and current-attempt consistency", async () => {
    const postgres = await fixture();
    try {
      await postgres.query(
        `insert into turns
           (id, tenant_id, session_id, state, input_kind, input_text, model_profile_id,
            provider, model_id, thinking_level, credential_binding_id, credential_binding_version)
         values ($1, $2, $3, 'queued', 'prompt', 'second', $4,
                 'agent-dock-fake', 'agent-dock-fake', 'off', $5, 1)`,
        [IDS.turn2, IDS.tenant, IDS.session, IDS.profile, IDS.credential],
      );
      await postgres.query(
        `insert into commands
           (id, tenant_id, session_id, turn_id, idempotency_key, kind, payload)
         values ($1, $2, $3, $4, 'run-request-2', 'turn.execute', '{}'::jsonb)`,
        [IDS.command2, IDS.tenant, IDS.session, IDS.turn2],
      );
      await postgres.query(
        `insert into runs
           (id, tenant_id, project_id, workspace_id, session_id, turn_id, command_id,
            idempotency_key, state)
         values ($1, $2, $3, $4, $5, $6, $7, 'run-request-2', 'queued')`,
        [IDS.run2, IDS.tenant, IDS.project, IDS.workspace, IDS.session, IDS.turn2, IDS.command2],
      );
      await postgres.query(
        `insert into run_attempts
           (id, tenant_id, run_id, attempt_number, state, claim_owner_id, claim_expires_at)
         values ($1, $2, $3, 1, 'claimed', 'worker-1', now() + interval '1 minute')`,
        [IDS.attempt2, IDS.tenant, IDS.run2],
      );
      await postgres.query(
        "update runs set current_attempt_id = $1, attempt_count = 1, state = 'claimed' where id = $2",
        [IDS.attempt2, IDS.run2],
      );

      await expect(
        postgres.query("update runs set state = 'completed', settled_at = null where id = $1", [
          IDS.run2,
        ]),
      ).rejects.toThrow();
      await expect(
        postgres.query("update runs set current_attempt_id = $1 where id = $2", [
          IDS.turn,
          IDS.run2,
        ]),
      ).rejects.toThrow();
      await expect(
        postgres.query(
          `insert into run_attempts
             (id, tenant_id, run_id, attempt_number, state, claim_owner_id, claim_expires_at)
           values ('b0000000-0000-4000-8000-000000000001', $1, $2, 1,
                   'claimed', 'worker-2', now() + interval '1 minute')`,
          [IDS.tenant, IDS.run2],
        ),
      ).rejects.toThrow();
    } finally {
      await postgres.close();
    }
  }, 20_000);

  it("rolls back without removing the existing turn lifecycle", async () => {
    const postgres = await fixture();
    try {
      await applyCompiledQueries(postgres, await compileMigration(downDurableRunsAndAttempts));
      const tables = await postgres.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('turns', 'runs', 'run_attempts', 'run_attempt_transitions')
          order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(["turns"]);
    } finally {
      await postgres.close();
    }
  }, 20_000);
});
