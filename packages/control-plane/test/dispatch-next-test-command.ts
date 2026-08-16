import type { Database } from "@pi-cloud/database";
import { TURN_COMMAND_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";

import {
  RunCommandExecutor,
  type RunCommandExecutionResult,
} from "@pi-cloud/runtime-core/run-command-executor";

/**
 * Test-only convenience for suites that create several accepted commands.
 *
 * Production code must never use this helper: the PostgreSQL Worker queue selects the command and
 * calls dispatchCommand(commandId). The helper tries accepted commands in
 * durable creation order so older state-machine tests do not need to duplicate
 * command lookup boilerplate.
 */
export async function dispatchNextTestCommand(
  database: Kysely<Database>,
  executor: RunCommandExecutor,
  tenantId?: string,
): Promise<RunCommandExecutionResult> {
  const commands = await database
    .selectFrom("outbox")
    .innerJoin("commands as command", (join) =>
      join
        .onRef("command.tenant_id", "=", "outbox.tenant_id")
        .on(
          sql<boolean>`${sql.ref("command.id")}::text = ${sql.ref(
            "outbox.payload",
          )} ->> 'commandId'`,
        ),
    )
    .select("command.id as commandId")
    .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
    .$if(tenantId !== undefined, (query) => query.where("outbox.tenant_id", "=", tenantId!))
    .where("outbox.published_at", "is", null)
    .where("command.kind", "=", "turn.execute")
    .where("command.state", "in", ["pending", "dispatched"])
    .orderBy("outbox.created_at", "asc")
    .orderBy("outbox.id", "asc")
    .execute();

  for (const command of commands) {
    const result = await executor.dispatchCommand(command.commandId);
    if (result.status !== "idle") return result;
  }
  return { status: "idle" };
}
