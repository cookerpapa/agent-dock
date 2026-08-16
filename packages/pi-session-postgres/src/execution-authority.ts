import type { Database } from "@pi-cloud/database";
import type { Transaction } from "kysely";

export type ExecutionAuthority = {
  assertCurrent(database?: Transaction<Database>): Promise<void>;
};

/** Opaque authority shared by Session writes and external Tool effects. */
export type ActiveExecutionAuthority = ExecutionAuthority & {
  readonly signal: AbortSignal;
  close(): Promise<void>;
};
