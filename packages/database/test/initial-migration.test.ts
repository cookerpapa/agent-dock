import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  downDurableEventDelivery,
  downInitialControlPlane,
  upDurableEventDelivery,
  upInitialControlPlane,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const IDS = {
  tenant: "00000000-0000-4000-8000-000000000001",
  tenant2: "00000000-0000-4000-8000-000000000002",
  project: "10000000-0000-4000-8000-000000000001",
  workspace: "20000000-0000-4000-8000-000000000001",
  credential: "30000000-0000-4000-8000-000000000001",
  profile: "40000000-0000-4000-8000-000000000001",
  session: "50000000-0000-4000-8000-000000000001",
  turn1: "60000000-0000-4000-8000-000000000001",
  turn2: "60000000-0000-4000-8000-000000000002",
  agent: "70000000-0000-4000-8000-000000000001",
  sandbox: "80000000-0000-4000-8000-000000000001",
  lease: "90000000-0000-4000-8000-000000000001",
  command1: "a0000000-0000-4000-8000-000000000001",
  command2: "a0000000-0000-4000-8000-000000000002",
  approval: "b0000000-0000-4000-8000-000000000001",
  event1: "c0000000-0000-4000-8000-000000000001",
  event2: "c0000000-0000-4000-8000-000000000002",
  usage: "d0000000-0000-4000-8000-000000000001",
};

const EXPECTED_TABLES = [
  "agent_nodes",
  "approvals",
  "artifacts",
  "commands",
  "credential_bindings",
  "model_profiles",
  "outbox",
  "projects",
  "sandboxes",
  "session_event_cursors",
  "session_events",
  "session_leases",
  "sessions",
  "tenants",
  "turns",
  "usage_ledger",
  "users",
  "workspaces",
] as const;

let postgres: PGlite;

async function seedControlPlane(): Promise<void> {
  await postgres.query(`insert into tenants (id, slug) values ($1, 'owner'), ($2, 'other')`, [
    IDS.tenant,
    IDS.tenant2,
  ]);
  await postgres.query(`insert into projects (id, tenant_id, name) values ($1, $2, 'AgentDock')`, [
    IDS.project,
    IDS.tenant,
  ]);
  await postgres.query(`insert into workspaces (id, tenant_id, project_id) values ($1, $2, $3)`, [
    IDS.workspace,
    IDS.tenant,
    IDS.project,
  ]);
  await postgres.query(
    `insert into credential_bindings
       (id, tenant_id, provider, kind, secret_ref, version, status)
     values ($1, $2, 'openai-codex', 'oauth', 'broker://owner/openai-codex', 1, 'active')`,
    [IDS.credential, IDS.tenant],
  );
  await postgres.query(
    `insert into model_profiles
       (id, tenant_id, name, provider, model_id, default_thinking_level,
        allowed_thinking_levels, credential_binding_id, credential_binding_version)
     values ($1, $2, 'default', 'openai-codex', 'gpt-5.4-mini', 'off',
             array['off', 'low'], $3, 1)`,
    [IDS.profile, IDS.tenant, IDS.credential],
  );
  await postgres.query(
    `insert into sessions
       (id, tenant_id, project_id, workspace_id, desired_model_profile_id)
     values ($1, $2, $3, $4, $5)`,
    [IDS.session, IDS.tenant, IDS.project, IDS.workspace, IDS.profile],
  );
  await postgres.query(
    `insert into agent_nodes
       (id, tenant_id, session_id, parent_agent_node_id, state, depth,
        model_profile_id, provider, model_id, thinking_level,
        credential_binding_id, credential_binding_version)
     values ($1, $2, $3, null, 'pending', 0, $4, 'openai-codex',
             'gpt-5.4-mini', 'off', $5, 1)`,
    [IDS.agent, IDS.tenant, IDS.session, IDS.profile, IDS.credential],
  );
  for (const turnId of [IDS.turn1, IDS.turn2]) {
    await postgres.query(
      `insert into turns
         (id, tenant_id, session_id, state, input_kind, input_text,
          model_profile_id, provider, model_id, thinking_level,
          credential_binding_id, credential_binding_version)
       values ($1, $2, $3, 'queued', 'prompt', 'hello', $4,
               'openai-codex', 'gpt-5.4-mini', 'off', $5, 1)`,
      [turnId, IDS.tenant, IDS.session, IDS.profile, IDS.credential],
    );
  }
}

beforeAll(async () => {
  postgres = new PGlite("memory://");
  await postgres.waitReady;
  await applyCompiledQueries(postgres, await compileMigration(upInitialControlPlane));
  await seedControlPlane();
}, 30_000);

afterAll(async () => {
  await postgres.close();
});

describe("initial PostgreSQL migration", () => {
  it("creates the complete control-plane schema", async () => {
    const result = await postgres.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);
  });

  it("keeps credential values out of model and session tables", async () => {
    const result = await postgres.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('model_profiles', 'sessions', 'turns')
          and column_name in ('access', 'access_token', 'refresh', 'refresh_token', 'api_key')`,
    );
    expect(result.rows).toEqual([]);

    await expect(
      postgres.query(
        `insert into model_profiles
           (id, tenant_id, name, provider, model_id, default_thinking_level,
            allowed_thinking_levels, credential_binding_id, credential_binding_version)
         values ('40000000-0000-4000-8000-000000000002', $1, 'invalid-thinking',
                 'openai-codex', 'gpt-5.4-mini', 'medium', array['off'], $2, 1)`,
        [IDS.tenant, IDS.credential],
      ),
    ).rejects.toThrow();
  });

  it("enforces tenant ownership through composite foreign keys", async () => {
    await expect(
      postgres.query(
        `insert into model_profiles
           (id, tenant_id, name, provider, model_id, default_thinking_level,
            allowed_thinking_levels, credential_binding_id, credential_binding_version)
         values ('40000000-0000-4000-8000-000000000003', $1, 'cross-tenant',
                 'openai-codex', 'gpt-5.4-mini', 'off', array['off'], $2, 1)`,
        [IDS.tenant2, IDS.credential],
      ),
    ).rejects.toThrow();
  });

  it("rotates credential bindings without rewriting accepted turns", async () => {
    await postgres.query(
      `insert into credential_bindings
         (id, tenant_id, provider, kind, secret_ref, version, status)
       values ($1, $2, 'openai-codex', 'oauth',
               'broker://owner/openai-codex/v2', 2, 'active')`,
      [IDS.credential, IDS.tenant],
    );
    await postgres.query(
      `update model_profiles
          set credential_binding_version = 2
        where id = $1`,
      [IDS.profile],
    );

    const profile = await postgres.query<{ credential_binding_version: number }>(
      `select credential_binding_version from model_profiles where id = $1`,
      [IDS.profile],
    );
    const turns = await postgres.query<{ credential_binding_version: number }>(
      `select credential_binding_version from turns where session_id = $1 order by id`,
      [IDS.session],
    );
    expect(profile.rows[0]?.credential_binding_version).toBe(2);
    expect(turns.rows.map((turn) => turn.credential_binding_version)).toEqual([1, 1]);
  });

  it("allows a queued mailbox but only one executing turn per session", async () => {
    await postgres.query(`update turns set state = 'dispatching' where id = $1`, [IDS.turn1]);
    await expect(
      postgres.query(`update turns set state = 'dispatching' where id = $1`, [IDS.turn2]),
    ).rejects.toThrow();

    await postgres.query(`update turns set state = 'queued' where id = $1`, [IDS.turn1]);
    await postgres.query(`update turns set state = 'dispatching' where id = $1`, [IDS.turn2]);
    const result = await postgres.query<{ state: string }>(
      `select state from turns where id = $1`,
      [IDS.turn2],
    );
    expect(result.rows[0]?.state).toBe("dispatching");
  });

  it("deduplicates client commands by session and idempotency key", async () => {
    await postgres.query(
      `insert into commands
         (id, tenant_id, session_id, turn_id, idempotency_key, kind, payload)
       values ($1, $2, $3, $4, 'request-1', 'turn.execute', '{}'::jsonb)`,
      [IDS.command1, IDS.tenant, IDS.session, IDS.turn1],
    );
    await expect(
      postgres.query(
        `insert into commands
           (id, tenant_id, session_id, turn_id, idempotency_key, kind, payload)
         values ($1, $2, $3, $4, 'request-1', 'turn.execute', '{}'::jsonb)`,
        [IDS.command2, IDS.tenant, IDS.session, IDS.turn1],
      ),
    ).rejects.toThrow();
  });

  it("deduplicates event sequence and bounds cumulative ACK", async () => {
    await postgres.query(
      `insert into session_events
         (event_id, tenant_id, session_id, turn_id, agent_node_id, seq,
          schema_version, type, payload, lease_id, fencing_token, occurred_at)
       values ($1, $2, $3, $4, $5, 1, 1, 'turn.started', '{}'::jsonb,
               $6, 1, now())`,
      [IDS.event1, IDS.tenant, IDS.session, IDS.turn1, IDS.agent, IDS.lease],
    );
    await expect(
      postgres.query(
        `insert into session_events
           (event_id, tenant_id, session_id, turn_id, agent_node_id, seq,
            schema_version, type, payload, lease_id, fencing_token, occurred_at)
         values ($1, $2, $3, $4, $5, 1, 1, 'turn.started', '{}'::jsonb,
                 $6, 1, now())`,
        [IDS.event2, IDS.tenant, IDS.session, IDS.turn1, IDS.agent, IDS.lease],
      ),
    ).rejects.toThrow();

    await expect(
      postgres.query(
        `insert into session_event_cursors
           (session_id, last_persisted_seq, acknowledged_through_seq)
         values ($1, 1, 2)`,
        [IDS.session],
      ),
    ).rejects.toThrow();
    await postgres.query(
      `insert into session_event_cursors
         (session_id, last_persisted_seq, acknowledged_through_seq)
       values ($1, 1, 1)`,
      [IDS.session],
    );
  });

  it("migrates public agent and command identity onto durable events", async () => {
    await applyCompiledQueries(postgres, await compileMigration(upDurableEventDelivery));
    const columns = await postgres.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'session_events'
          and column_name in ('agent_id', 'command_id')
        order by column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "agent_id", is_nullable: "NO" },
      { column_name: "command_id", is_nullable: "YES" },
    ]);
    const backfilled = await postgres.query<{ agent_id: string; command_id: string | null }>(
      `select agent_id, command_id from session_events where event_id = $1`,
      [IDS.event1],
    );
    expect(backfilled.rows[0]).toEqual({ agent_id: IDS.agent, command_id: null });

    await postgres.query(
      `insert into commands
         (id, tenant_id, session_id, turn_id, idempotency_key, kind, payload)
       values ($1, $2, $3, $4, 'request-2', 'turn.execute', '{}'::jsonb)`,
      [IDS.command2, IDS.tenant, IDS.session, IDS.turn2],
    );
    await expect(
      postgres.query(`update session_events set command_id = $1 where event_id = $2`, [
        IDS.command2,
        IDS.event1,
      ]),
    ).rejects.toThrow();
    await postgres.query(
      `update session_events set agent_id = 'root', command_id = $1 where event_id = $2`,
      [IDS.command1, IDS.event1],
    );
    await expect(
      postgres.query(`update session_events set agent_id = '' where event_id = $1`, [IDS.event1]),
    ).rejects.toThrow();
  });

  it("requires approval outcome and resolution time to match state", async () => {
    await expect(
      postgres.query(
        `insert into approvals
           (id, tenant_id, session_id, turn_id, kind, state, request_payload)
         values ($1, $2, $3, $4, 'confirm', 'resolved', '{}'::jsonb)`,
        [IDS.approval, IDS.tenant, IDS.session, IDS.turn1],
      ),
    ).rejects.toThrow();

    await postgres.query(
      `insert into approvals
         (id, tenant_id, session_id, turn_id, kind, state, request_payload)
       values ($1, $2, $3, $4, 'confirm', 'pending', '{}'::jsonb)`,
      [IDS.approval, IDS.tenant, IDS.session, IDS.turn1],
    );
    await postgres.query(
      `update approvals
          set state = 'resolved', outcome = 'approved', resolved_at = now()
        where id = $1`,
      [IDS.approval],
    );
  });

  it("rejects invalid fencing, capacity, and usage values", async () => {
    await postgres.query(
      `insert into sandboxes
         (id, supervisor_id, boot_id, state, max_concurrent_sessions, active_sessions)
       values ($1, 'supervisor-1', '80000000-0000-4000-8000-000000000002',
               'ready', 1, 0)`,
      [IDS.sandbox],
    );
    await expect(
      postgres.query(`update sandboxes set active_sessions = 2 where id = $1`, [IDS.sandbox]),
    ).rejects.toThrow();
    await expect(
      postgres.query(
        `insert into session_leases
           (session_id, lease_id, sandbox_id, fencing_token, valid_until)
         values ($1, $2, $3, 0, now() + interval '1 minute')`,
        [IDS.session, IDS.lease, IDS.sandbox],
      ),
    ).rejects.toThrow();
    await expect(
      postgres.query(
        `insert into usage_ledger
           (id, tenant_id, session_id, turn_id, provider, model_id,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_amount)
         values ($1, $2, $3, $4, 'openai-codex', 'gpt-5.4-mini',
                 -1, 1, 0, 0, 0)`,
        [IDS.usage, IDS.tenant, IDS.session, IDS.turn1],
      ),
    ).rejects.toThrow();
  });

  it("drops every application table in reverse dependency order", async () => {
    await applyCompiledQueries(postgres, await compileMigration(downDurableEventDelivery));
    await applyCompiledQueries(postgres, await compileMigration(upDurableEventDelivery));
    await applyCompiledQueries(postgres, await compileMigration(downInitialControlPlane));
    const result = await postgres.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    expect(result.rows).toEqual([]);
  });
});
