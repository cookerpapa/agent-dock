import type { Database } from "@agent-dock/database";
import type { Transaction } from "kysely";

export type ExecutionAuthority = {
  assertCurrent(database?: Transaction<Database>): Promise<void>;
};
