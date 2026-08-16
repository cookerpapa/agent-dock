import type { Database } from "@pi-cloud/database";
import type { Session } from "@earendil-works/pi-agent-core";
import type { Kysely } from "kysely";
import { PostgresRunExecutionAuthority } from "./postgres-execution-authority.ts";
import { PostgresPiSessionRepository } from "./postgres-session-repository.ts";

export type CloudAgentExecutionScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
}>;

export type OpenPostgresDurableAgentSessionOptions = Readonly<{
  database: Kysely<Database>;
  scope: CloudAgentExecutionScope;
  claimOwnerId: string;
  fencingToken: number;
  pollIntervalMs?: number;
  clock?: () => Date;
}>;

export type PostgresDurableAgentSession = Readonly<{
  session: Session;
  authority: PostgresRunExecutionAuthority;
}>;

/**
 * Opens a Pi Session and the exact same opaque authority used by Session writes
 * and remote Tool effects.
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
    const repository = new PostgresPiSessionRepository({
      database: options.database,
      tenantId: options.scope.tenantId,
      authority,
    });
    const session = await repository.openOrCreate({ id: options.scope.sessionId });
    return {
      session,
      authority,
    };
  } catch (error: unknown) {
    await authority.close();
    throw error;
  }
}
