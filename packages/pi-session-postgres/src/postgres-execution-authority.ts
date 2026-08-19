import type { Database } from "@pi-cloud/database";
import { SessionError } from "@earendil-works/pi-agent-core";
import type { Kysely, Transaction } from "kysely";
import type { ActiveExecutionAuthority } from "./execution-authority.ts";

export type PostgresRunExecutionAuthorityOptions = {
  database: Kysely<Database>;
  tenantId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  claimOwnerId: string;
  fencingToken: number;
  clock?: () => Date;
  pollIntervalMs?: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** Opaque Run authority checked at each durable Pi Session effect boundary. */
export class PostgresRunExecutionAuthority implements ActiveExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #runId: string;
  readonly #attemptId: string;
  readonly #claimOwnerId: string;
  readonly #fencingToken: string;
  readonly #clock: () => Date;
  readonly #pollIntervalMs: number;
  readonly #abort = new AbortController();
  #watch: Promise<void> | undefined;
  #closed = false;

  constructor(options: PostgresRunExecutionAuthorityOptions) {
    if (!Number.isSafeInteger(options.fencingToken) || options.fencingToken < 1) {
      throw new TypeError("fencingToken must be a positive safe integer");
    }
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#sessionId = options.sessionId;
    this.#runId = options.runId;
    this.#attemptId = options.attemptId;
    this.#claimOwnerId = options.claimOwnerId;
    this.#fencingToken = String(options.fencingToken);
    this.#clock = options.clock ?? (() => new Date());
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  start(): void {
    if (this.#closed) throw new Error("PostgreSQL Run execution authority is closed");
    this.#watch ??= this.#watchCurrent();
  }

  async assertCurrent(database?: Transaction<Database>): Promise<void> {
    if (this.#closed || this.#abort.signal.aborted) {
      throw new SessionError("storage", "Pi Session execution authority is no longer active");
    }
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
      .where("run.session_id", "=", this.#sessionId)
      .where("run.id", "=", this.#runId)
      .where("attempt.id", "=", this.#attemptId)
      .where("attempt.claim_owner_id", "=", this.#claimOwnerId)
      .where("attempt.claim_expires_at", ">", this.#clock())
      .where("attempt.fencing_token", "=", this.#fencingToken)
      // Cancellation revokes Tool authority first, then the active Pi runtime
      // must persist its bounded interruption/unknown-effect facts before the
      // Attempt becomes terminal. The same Attempt/Fence remains the only
      // Session writer throughout cancel_requested.
      .where("attempt.state", "in", [
        "provisioning",
        "restoring",
        "running",
        "checkpointing",
        "cancel_requested",
      ])
      .where("run.state", "in", [
        "claimed",
        "provisioning",
        "restoring",
        "running",
        "checkpointing",
        "cancel_requested",
      ])
      .executeTakeFirst();
    if (row === undefined) {
      const error = new SessionError(
        "storage",
        "Pi Session mutation was rejected by stale execution authority",
      );
      this.#abort.abort(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort(new Error("PostgreSQL Run execution authority closed"));
    await this.#watch;
  }

  async #watchCurrent(): Promise<void> {
    while (!this.#closed && !this.#abort.signal.aborted) {
      await new Promise<void>((resolvePromise) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#abort.signal.removeEventListener("abort", settle);
          resolvePromise();
        };
        const timer = setTimeout(settle, this.#pollIntervalMs);
        timer.unref();
        this.#abort.signal.addEventListener("abort", settle, { once: true });
      });
      if (this.#closed || this.#abort.signal.aborted) return;
      try {
        await this.assertCurrent();
      } catch {
        return;
      }
    }
  }
}
