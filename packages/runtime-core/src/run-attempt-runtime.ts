import type { Database } from "@pi-cloud/database";
import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import type {
  RunAttemptExecutionPhase,
  RunAttemptPhaseObserver,
} from "@pi-cloud/sandbox-supervisor";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { transitionCurrentRunAttempt } from "./run-attempt-state.ts";

export type PostgresRunAttemptPhaseObserverOptions = {
  database: Kysely<Database>;
  clock?: () => Date;
  idGenerator?: () => string;
};

function validDate(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new TypeError("run attempt phase clock must return a valid Date");
  }
  return now;
}

export class PostgresRunAttemptPhaseObserver implements RunAttemptPhaseObserver {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PostgresRunAttemptPhaseObserverOptions) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async transition(
    command: ExecuteTurnCommandMessage,
    phase: RunAttemptExecutionPhase,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: command.payload.tenantId,
          runId: command.payload.runId,
          attemptId: command.payload.attemptId,
          leaseId: command.payload.leaseId,
          fencingToken: command.payload.fencingToken,
        },
        {
          runState: phase,
          attemptState: phase,
          reason: `trusted_runner_${phase}`,
          now,
          heartbeat: true,
          transitionId: this.#idGenerator(),
        },
      );
    });
  }

  async checkpointCommitted(command: ExecuteTurnCommandMessage, revision: string): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: command.payload.tenantId,
          runId: command.payload.runId,
          attemptId: command.payload.attemptId,
          leaseId: command.payload.leaseId,
          fencingToken: command.payload.fencingToken,
        },
        {
          runState: "checkpointing",
          attemptState: "checkpointing",
          reason: "checkpoint_committed",
          checkpointRevision: revision,
          now,
          heartbeat: true,
          transitionId: this.#idGenerator(),
        },
      );
    });
  }
}
