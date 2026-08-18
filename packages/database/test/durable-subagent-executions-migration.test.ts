import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downDurableSubagentExecutions,
  downIsolatedSubagentWorkspaces,
  upDurableSubagentExecutions,
  upIsolatedSubagentWorkspaces,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PARENT_SESSION = "00000000-0000-4000-8000-000000000002";
const CHILD_SESSION = "00000000-0000-4000-8000-000000000003";
const PARENT_RUN = "00000000-0000-4000-8000-000000000004";
const CHILD_RUN = "00000000-0000-4000-8000-000000000005";
const PARENT_ATTEMPT = "00000000-0000-4000-8000-000000000006";
const PARENT_WORKSPACE = "00000000-0000-4000-8000-000000000008";
const CHILD_WORKSPACE = "00000000-0000-4000-8000-000000000009";

describe("durable Subagent executions migration", () => {
  it("separates delegated Sessions from conversation branches and constrains identities", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table sessions (
          id uuid primary key,
          tenant_id uuid not null,
          unique (tenant_id, id)
        );
        create table runs (
          id uuid primary key,
          tenant_id uuid not null,
          unique (tenant_id, id)
        );
        create table run_attempts (
          id uuid primary key,
          tenant_id uuid not null,
          run_id uuid not null,
          unique (tenant_id, run_id, id)
        );
        create table workspaces (
          id uuid primary key,
          tenant_id uuid not null,
          created_at timestamptz not null default now(),
          unique (tenant_id, id)
        );
        insert into sessions values
          ('${PARENT_SESSION}', '${TENANT}'),
          ('${CHILD_SESSION}', '${TENANT}');
        insert into runs values
          ('${PARENT_RUN}', '${TENANT}'),
          ('${CHILD_RUN}', '${TENANT}');
        insert into run_attempts values
          ('${PARENT_ATTEMPT}', '${TENANT}', '${PARENT_RUN}');
        insert into workspaces (id, tenant_id) values
          ('${PARENT_WORKSPACE}', '${TENANT}'),
          ('${CHILD_WORKSPACE}', '${TENANT}');
      `);
      await applyCompiledQueries(postgres, await compileMigration(upDurableSubagentExecutions));

      const defaultKind = await postgres.query<{ session_kind: string }>(`
        select session_kind from sessions where id = '${PARENT_SESSION}'
      `);
      expect(defaultKind.rows).toEqual([{ session_kind: "conversation" }]);

      await postgres.exec(`
        update sessions set session_kind = 'subagent' where id = '${CHILD_SESSION}';
        insert into subagent_executions (
          id, tenant_id, parent_session_id, parent_run_id, parent_attempt_id,
          parent_tool_call_id, workflow_run_id, step_index, child_session_id,
          child_run_id, agent_name, context_mode, workspace_mode, state, request_sha256
        ) values (
          '00000000-0000-4000-8000-000000000007', '${TENANT}', '${PARENT_SESSION}',
          '${PARENT_RUN}', '${PARENT_ATTEMPT}', 'tool-1', 'workflow-1', 0,
          '${CHILD_SESSION}', '${CHILD_RUN}', 'scout', 'fresh', 'shared_serialized', 'queued',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        );
      `);

      await expect(
        postgres.exec(`update subagent_executions set workspace_mode = 'shared_unfenced'`),
      ).rejects.toThrow();
      await expect(
        postgres.exec(`update subagent_executions set state = 'failed'`),
      ).rejects.toThrow();

      await postgres.exec(`
        update subagent_executions
        set state = 'completed', settled_at = now()
      `);
      const execution = await postgres.query<{ state: string; workspace_mode: string }>(`
        select state, workspace_mode from subagent_executions
      `);
      expect(execution.rows).toEqual([{ state: "completed", workspace_mode: "shared_serialized" }]);

      await applyCompiledQueries(postgres, await compileMigration(upIsolatedSubagentWorkspaces));
      await postgres.exec(`
        update workspaces
        set workspace_kind = 'subagent_isolated', parent_workspace_id = '${PARENT_WORKSPACE}'
        where id = '${CHILD_WORKSPACE}';
        update subagent_executions
        set workspace_mode = 'isolated', child_workspace_id = '${CHILD_WORKSPACE}';
      `);
      await expect(
        postgres.exec(`update subagent_executions set child_workspace_id = null`),
      ).rejects.toThrow();
      const isolated = await postgres.query<{
        workspace_kind: string;
        child_workspace_id: string;
      }>(`
        select workspace.workspace_kind, execution.child_workspace_id
        from subagent_executions as execution
        join workspaces as workspace on workspace.id = execution.child_workspace_id
      `);
      expect(isolated.rows).toEqual([
        { workspace_kind: "subagent_isolated", child_workspace_id: CHILD_WORKSPACE },
      ]);

      await applyCompiledQueries(postgres, await compileMigration(downIsolatedSubagentWorkspaces));
      await applyCompiledQueries(postgres, await compileMigration(downDurableSubagentExecutions));
      const columns = await postgres.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_name = 'sessions' and column_name = 'session_kind'
      `);
      expect(columns.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  }, 15_000);
});
