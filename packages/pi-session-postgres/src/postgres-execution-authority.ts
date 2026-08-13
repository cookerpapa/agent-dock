import type { Database } from "@agent-dock/database";
import { SessionError } from "@earendil-works/pi-agent-core";
import type { Kysely, Transaction } from "kysely";
import type { ExecutionAuthority } from "./index.ts";

export type PostgresRunExecutionAuthorityOptions = {
  database: Kysely<Database>;
  tenantId: string;
  runId: string;
  attemptId: string;
  claimOwnerId: string;
  fencingToken: number;
  clock?: () => Date;
};

/** Opaque Harness authority checked at each durable Pi Session effect boundary. */
export class PostgresRunExecutionAuthority implements ExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #runId: string;
  readonly #attemptId: string;
  readonly #claimOwnerId: string;
  readonly #fencingToken: string;
  readonly #clock: () => Date;

  constructor(options: PostgresRunExecutionAuthorityOptions) {
    if (!Number.isSafeInteger(options.fencingToken) || options.fencingToken < 1) {
      throw new TypeError("fencingToken must be a positive safe integer");
    }
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#runId = options.runId;
    this.#attemptId = options.attemptId;
    this.#claimOwnerId = options.claimOwnerId;
    this.#fencingToken = String(options.fencingToken);
    this.#clock = options.clock ?? (() => new Date());
  }

  async assertCurrent(database?: Transaction<Database>): Promise<void> {
    const authority = database ?? this.#database;
    const row = await authority
      .selectFrom("runs as run")
      .innerJoin("run_attempts as attempt", (join) =>
        join
          .onRef("attempt.run_id", "=", "run.id")
          .onRef("attempt.id", "=", "run.current_attempt_id"),
      )
      .select("attempt.id")
      .where("run.tenant_id", "=", this.#tenantId)
      .where("run.id", "=", this.#runId)
      .where("attempt.id", "=", this.#attemptId)
      .where("attempt.claim_owner_id", "=", this.#claimOwnerId)
      .where("attempt.claim_expires_at", ">", this.#clock())
      .where("attempt.fencing_token", "=", this.#fencingToken)
      .where("attempt.state", "in", ["provisioning", "restoring", "running", "checkpointing"])
      .where("run.state", "in", [
        "claimed",
        "provisioning",
        "restoring",
        "running",
        "checkpointing",
      ])
      .executeTakeFirst();
    if (row === undefined) {
      throw new SessionError(
        "storage",
        "Pi Session mutation was rejected by stale execution authority",
      );
    }
  }
}
