import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downConversationTailPruning, upConversationTailPruning } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("conversation tail-pruning migration", () => {
  it("adds bounded idempotent prune records and a visible-Turn marker", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table sessions (
          tenant_id uuid not null,
          id uuid not null,
          primary key (id),
          unique (tenant_id, id)
        );
        create table turns (
          tenant_id uuid not null,
          id uuid not null,
          session_id uuid not null,
          created_at timestamptz not null default now(),
          primary key (id),
          unique (tenant_id, id),
          unique (tenant_id, session_id, id)
        );
        insert into sessions values (
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001'
        );
        insert into turns (tenant_id, id, session_id) values (
          '10000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001'
        );
      `);
      await applyCompiledQueries(postgres, await compileMigration(upConversationTailPruning));
      await postgres.exec(`
        update turns set pruned_at = now();
        insert into conversation_prune_operations (
          tenant_id, session_id, idempotency_key, request_sha256,
          anchor_turn_id, anchor_entry_id, pruned_turn_count, archived_session_count
        ) values (
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'prune:test', repeat('a', 64),
          '30000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000001', 2, 3
        );
      `);
      await expect(
        postgres.exec(`
          update conversation_prune_operations set pruned_turn_count = -1
        `),
      ).rejects.toThrow();
      await applyCompiledQueries(postgres, await compileMigration(downConversationTailPruning));
    } finally {
      await postgres.close();
    }
  });
});
