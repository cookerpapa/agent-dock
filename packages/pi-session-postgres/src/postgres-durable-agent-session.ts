import type { Database } from "@agent-dock/database";
import type { Session } from "@earendil-works/pi-agent-core";
import type { Kysely } from "kysely";
import {
  FixedDurableAgentExecutionAuthorityProvider,
  type DurableAgentExecutionAuthorityProvider,
  type DurableAgentExecutionScope,
} from "./durable-agent-harness.ts";
import { PostgresRunExecutionAuthority } from "./postgres-execution-authority.ts";
import { PostgresPiSessionStorage } from "./index.ts";

export type OpenPostgresDurableAgentSessionOptions = Readonly<{
  database: Kysely<Database>;
  scope: DurableAgentExecutionScope;
  claimOwnerId: string;
  fencingToken: number;
  pollIntervalMs?: number;
  clock?: () => Date;
}>;

export type PostgresDurableAgentSession = Readonly<{
  session: Session;
  authorityProvider: DurableAgentExecutionAuthorityProvider;
}>;

/**
 * Constructs a Pi Session and Harness provider around the exact same
 * PostgreSQL execution authority, closing the check/use race at durable writes.
 */
export async function openPostgresDurableAgentSession(
  options: OpenPostgresDurableAgentSessionOptions,
): Promise<PostgresDurableAgentSession> {
  const authority = new PostgresRunExecutionAuthority({
    database: options.database,
    tenantId: options.scope.tenantId,
    sessionId: options.scope.sessionId,
    runId: options.scope.runId,
    attemptId: options.scope.attemptId,
    claimOwnerId: options.claimOwnerId,
    fencingToken: options.fencingToken,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await authority.assertCurrent();
  authority.start();
  try {
    const storage = await PostgresPiSessionStorage.openOrCreate({
      database: options.database,
      tenantId: options.scope.tenantId,
      sessionId: options.scope.sessionId,
      authority,
    });
    return {
      session: storage.asSession(),
      authorityProvider: new FixedDurableAgentExecutionAuthorityProvider(options.scope, authority),
    };
  } catch (error: unknown) {
    await authority.close();
    throw error;
  }
}
