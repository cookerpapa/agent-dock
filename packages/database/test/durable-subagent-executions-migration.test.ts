import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downDurableSubagentExecutions, upDurableSubagentExecutions } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PARENT_SESSION = "00000000-0000-4000-8000-000000000002";
const CHILD_SESSION = "00000000-0000-4000-8000-000000000003";
const PARENT_RUN = "00000000-0000-4000-8000-000000000004";
const CHILD_RUN = "00000000-0000-4000-8000-000000000005";
const PARENT_ATTEMPT = "00000000-0000-4000-8000-000000000006";

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
        insert into sessions values
          ('${PARENT_SESSION}', '${TENANT}'),
          ('${CHILD_SESSION}', '${TENANT}');
        insert into runs values
          ('${PARENT_RUN}', '${TENANT}'),
          ('${CHILD_RUN}', '${TENANT}');
        insert into run_attempts values
          ('${PARENT_ATTEMPT}', '${TENANT}', '${PARENT_RUN}');
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
          child_run_id, agent_name, context_mode, workspace_mode, state
        ) values (
          '00000000-0000-4000-8000-000000000007', '${TENANT}', '${PARENT_SESSION}',
          '${PARENT_RUN}', '${PARENT_ATTEMPT}', 'tool-1', 'workflow-1', 0,
          '${CHILD_SESSION}', '${CHILD_RUN}', 'scout', 'fresh', 'shared_serialized', 'queued'
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

      await applyCompiledQueries(postgres, await compileMigration(downDurableSubagentExecutions));
      const columns = await postgres.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_name = 'sessions' and column_name = 'session_kind'
      `);
      expect(columns.rows).toEqual([]);
    } finally {
      await postgres.close();
    }
  });
});
