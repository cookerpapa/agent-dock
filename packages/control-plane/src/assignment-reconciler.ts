import type { Database } from "@agent-dock/database";
import {
  transitionAgentNode,
  transitionApproval,
  transitionCommand,
  transitionSandbox,
  transitionSession,
  transitionTurn,
  type SandboxState,
} from "@agent-dock/domain";
import type {
  SandboxAssignmentInventory,
  SandboxRuntimeAssignment,
} from "@agent-dock/sandbox-supervisor";
import { sql, type Kysely, type Transaction } from "kysely";

const ASSIGNMENT_LOST = "assignment_lost";
const ASSIGNMENT_LOST_MESSAGE =
  "The sandbox assignment disappeared before the turn reached a durable terminal state";
const DEFAULT_RECONCILIATION_LIMIT = 100;

const ACTIVE_SESSION_STATES = new Set(["starting", "running", "waiting_approval", "cancelling"]);
const ACTIVE_TURN_STATES = new Set(["dispatching", "running", "waiting_approval", "cancelling"]);
const NONTERMINAL_COMMAND_STATES = new Set(["pending", "dispatched", "acknowledged"]);

export type AssignmentReconcilerOptions = {
  database: Kysely<Database>;
  sandboxId: string;
  inventory: SandboxAssignmentInventory;
  clock?: () => Date;
};

export type AssignmentReconciliationResult = {
  inspectedRuntimes: number;
  terminatedRuntimes: number;
  orphanRuntimes: number;
  settledAssignments: number;
  requeuedAssignments: number;
};

export type SandboxRetirementResult = AssignmentReconciliationResult & {
  sandboxState: "terminated";
};

export class AssignmentReconcilerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "AssignmentReconcilerError";
    this.code = code;
    this.retryable = retryable;
  }
}

type DurableAssignment = {
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  validUntil: Date;
  commandId: string | null;
  turnId: string | null;
};

type Finalization = "settled" | "requeued" | "released" | "skipped";

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("assignment reconciler clock must return a valid Date");
  }
  return value;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AssignmentReconcilerError(
      "assignment_invariant",
      `${name} is outside the supported integer range`,
      false,
    );
  }
  return parsed;
}

function sameLease(runtime: SandboxRuntimeAssignment, durable: DurableAssignment): boolean {
  return (
    runtime.sessionId === durable.sessionId &&
    runtime.leaseId === durable.leaseId &&
    runtime.fencingToken === durable.fencingToken
  );
}

function sameAssignment(runtime: SandboxRuntimeAssignment, durable: DurableAssignment): boolean {
  return (
    sameLease(runtime, durable) &&
    durable.commandId !== null &&
    durable.turnId !== null &&
    runtime.commandId === durable.commandId &&
    runtime.turnId === durable.turnId
  );
}

function emptyResult(inspectedRuntimes: number): AssignmentReconciliationResult {
  return {
    inspectedRuntimes,
    terminatedRuntimes: 0,
    orphanRuntimes: 0,
    settledAssignments: 0,
    requeuedAssignments: 0,
  };
}

/**
 * Reconciles a sandbox only after its owning supervisor boot has been fenced
 * by the caller and can no longer create a runtime for an observed command.
 * Runtime absence is not a substitute for that supervisor-liveness decision.
 */
export class AssignmentReconciler {
  readonly #database: Kysely<Database>;
  readonly #sandboxId: string;
  readonly #inventory: SandboxAssignmentInventory;
  readonly #clock: () => Date;

  constructor(options: AssignmentReconcilerOptions) {
    if (options.sandboxId.trim().length === 0) {
      throw new TypeError("sandboxId must not be empty");
    }
    this.#database = options.database;
    this.#sandboxId = options.sandboxId;
    this.#inventory = options.inventory;
    this.#clock = options.clock ?? (() => new Date());
  }

  async reconcileExpiredAssignments(
    limit = DEFAULT_RECONCILIATION_LIMIT,
  ): Promise<AssignmentReconciliationResult> {
    const boundedLimit = positiveInteger(limit, "limit");
    const now = validDate(this.#clock);
    try {
      const runtimes = await this.#inventory.listAssignments();
      const sandbox = await this.#loadSandboxIdentity();
      this.#assertRuntimeScope(runtimes, sandbox);
      const durableAssignments = await this.#loadDurableAssignments();
      const targets = durableAssignments
        .filter((assignment) => assignment.validUntil.valueOf() <= now.valueOf())
        .slice(0, boundedLimit);
      const targetKeys = new Set(targets.map((assignment) => assignment.leaseId));
      const orphans = runtimes.filter(
        (runtime) => !durableAssignments.some((assignment) => sameAssignment(runtime, assignment)),
      );
      const targetRuntimes = runtimes.filter((runtime) =>
        targets.some(
          (assignment) => targetKeys.has(runtime.leaseId) && sameAssignment(runtime, assignment),
        ),
      );
      const toTerminate = [
        ...new Map(
          [...orphans, ...targetRuntimes].map((runtime) => [runtime.runtimeId, runtime]),
        ).values(),
      ];
      for (const runtime of toTerminate) {
        await this.#inventory.terminateAndConfirmAbsent(runtime);
      }

      const result = emptyResult(runtimes.length);
      result.terminatedRuntimes = toTerminate.length;
      result.orphanRuntimes = orphans.length;
      await this.#database.transaction().execute(async (transaction) => {
        for (const target of targets) {
          const finalized = await this.#finalizeLease(transaction, target, now, true);
          if (finalized === "requeued") result.requeuedAssignments += 1;
          if (finalized === "settled" || finalized === "released") {
            result.settledAssignments += 1;
          }
        }
        await this.#synchronizeCapacity(transaction, now);
      });
      return result;
    } catch (error: unknown) {
      await this.#quarantineSandbox(now).catch(() => undefined);
      throw this.#normalizeError(error);
    }
  }

  async retireSandbox(): Promise<SandboxRetirementResult> {
    const now = validDate(this.#clock);
    try {
      await this.#beginRetirement(now);
      const runtimes = await this.#inventory.listAssignments();
      const sandbox = await this.#loadSandboxIdentity();
      this.#assertRuntimeScope(runtimes, sandbox);
      const durableAssignments = await this.#loadDurableAssignments();
      const orphans = runtimes.filter(
        (runtime) => !durableAssignments.some((assignment) => sameAssignment(runtime, assignment)),
      );
      for (const runtime of runtimes) {
        await this.#inventory.terminateAndConfirmAbsent(runtime);
      }

      const result = emptyResult(runtimes.length);
      result.terminatedRuntimes = runtimes.length;
      result.orphanRuntimes = orphans.length;
      await this.#database.transaction().execute(async (transaction) => {
        for (const assignment of durableAssignments) {
          const finalized = await this.#finalizeLease(transaction, assignment, now, false);
          if (finalized === "requeued") result.requeuedAssignments += 1;
          if (finalized === "settled" || finalized === "released") {
            result.settledAssignments += 1;
          }
        }
        const remaining = await transaction
          .selectFrom("session_leases")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("sandbox_id", "=", this.#sandboxId)
          .executeTakeFirstOrThrow();
        if (safeInteger(remaining.count, "remaining sandbox lease count") !== 0) {
          throw new AssignmentReconcilerError(
            "assignment_reconciliation_incomplete",
            "Sandbox retirement retained an assignment",
            true,
          );
        }
        const row = await transaction
          .selectFrom("sandboxes")
          .select(["state"])
          .where("id", "=", this.#sandboxId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (row.state !== "terminated") {
          if (row.state !== "draining" && row.state !== "failed" && row.state !== "provisioning") {
            throw new AssignmentReconcilerError(
              "sandbox_retirement_invariant",
              "Sandbox was not fenced before retirement",
              false,
            );
          }
          await transaction
            .updateTable("sandboxes")
            .set({
              state: transitionSandbox(row.state, "terminated"),
              active_sessions: 0,
              updated_at: now,
              terminated_at: now,
            })
            .where("id", "=", this.#sandboxId)
            .where("state", "=", row.state)
            .executeTakeFirstOrThrow();
        }
      });
      return { ...result, sandboxState: "terminated" };
    } catch (error: unknown) {
      await this.#quarantineSandbox(now).catch(() => undefined);
      throw this.#normalizeError(error);
    }
  }

  async #loadSandboxIdentity(): Promise<{
    supervisorId: string;
    bootId: string;
    state: SandboxState;
  }> {
    const sandbox = await this.#database
      .selectFrom("sandboxes")
      .select(["supervisor_id", "boot_id", "state"])
      .where("id", "=", this.#sandboxId)
      .executeTakeFirst();
    if (sandbox === undefined) {
      throw new AssignmentReconcilerError(
        "sandbox_unavailable",
        "Reconciliation sandbox was unavailable",
        false,
      );
    }
    return {
      supervisorId: sandbox.supervisor_id,
      bootId: sandbox.boot_id,
      state: sandbox.state,
    };
  }

  #assertRuntimeScope(
    runtimes: readonly SandboxRuntimeAssignment[],
    sandbox: { supervisorId: string; bootId: string },
  ): void {
    for (const runtime of runtimes) {
      if (
        runtime.sandboxId !== this.#sandboxId ||
        runtime.supervisorId !== sandbox.supervisorId ||
        runtime.bootId !== sandbox.bootId
      ) {
        throw new AssignmentReconcilerError(
          "runtime_identity_mismatch",
          "Observed runtime identity did not match its durable sandbox",
          false,
        );
      }
    }
  }

  async #loadDurableAssignments(): Promise<DurableAssignment[]> {
    const leases = await this.#database
      .selectFrom("session_leases")
      .select(["session_id", "lease_id", "fencing_token", "valid_until"])
      .where("sandbox_id", "=", this.#sandboxId)
      .orderBy("valid_until", "asc")
      .execute();
    const assignments: DurableAssignment[] = [];
    for (const lease of leases) {
      const turns = await this.#database
        .selectFrom("turns")
        .select(["id"])
        .where("session_id", "=", lease.session_id)
        .where("state", "in", ["dispatching", "running", "waiting_approval", "cancelling"])
        .orderBy("created_at", "desc")
        .limit(2)
        .execute();
      if (turns.length > 1) {
        throw new AssignmentReconcilerError(
          "assignment_invariant",
          "Session had multiple active turns during reconciliation",
          false,
        );
      }
      const turnId = turns[0]?.id ?? null;
      const commands =
        turnId === null
          ? []
          : await this.#database
              .selectFrom("commands")
              .select(["id"])
              .where("session_id", "=", lease.session_id)
              .where("turn_id", "=", turnId)
              .where("kind", "=", "turn.execute")
              .where("state", "in", ["pending", "dispatched", "acknowledged"])
              .limit(2)
              .execute();
      if (commands.length > 1) {
        throw new AssignmentReconcilerError(
          "assignment_invariant",
          "Turn had multiple active execution commands during reconciliation",
          false,
        );
      }
      assignments.push({
        sessionId: lease.session_id,
        leaseId: lease.lease_id,
        fencingToken: safeInteger(lease.fencing_token, "assignment fencing token"),
        validUntil: new Date(lease.valid_until),
        commandId: commands[0]?.id ?? null,
        turnId,
      });
    }
    return assignments;
  }

  async #finalizeLease(
    transaction: Transaction<Database>,
    candidate: DurableAssignment,
    now: Date,
    requireExpired: boolean,
  ): Promise<Finalization> {
    const lease = await transaction
      .selectFrom("session_leases")
      .select(["lease_id", "sandbox_id", "fencing_token", "valid_until"])
      .where("session_id", "=", candidate.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (
      lease === undefined ||
      lease.lease_id !== candidate.leaseId ||
      lease.sandbox_id !== this.#sandboxId ||
      safeInteger(lease.fencing_token, "final assignment fencing token") !==
        candidate.fencingToken ||
      (requireExpired && new Date(lease.valid_until).valueOf() > now.valueOf())
    ) {
      return "skipped";
    }

    const session = await transaction
      .selectFrom("sessions")
      .select(["tenant_id", "state"])
      .where("id", "=", candidate.sessionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const turns = await transaction
      .selectFrom("turns")
      .select(["id", "state"])
      .where("session_id", "=", candidate.sessionId)
      .where("state", "in", ["dispatching", "running", "waiting_approval", "cancelling"])
      .forUpdate()
      .execute();
    if (turns.length > 1) {
      throw new AssignmentReconcilerError(
        "assignment_invariant",
        "Session had multiple active turns while finalizing an assignment",
        false,
      );
    }
    const turn = turns[0];
    if (turn === undefined) {
      if (ACTIVE_SESSION_STATES.has(session.state)) {
        throw new AssignmentReconcilerError(
          "assignment_invariant",
          "Active session had no active turn during reconciliation",
          false,
        );
      }
      await this.#deleteLease(transaction, candidate);
      return "released";
    }

    const commands = await transaction
      .selectFrom("commands")
      .select(["id", "kind", "state"])
      .where("session_id", "=", candidate.sessionId)
      .where("turn_id", "=", turn.id)
      .where("state", "in", ["pending", "dispatched", "acknowledged"])
      .forUpdate()
      .execute();
    const executeCommands = commands.filter((command) => command.kind === "turn.execute");
    if (executeCommands.length !== 1) {
      throw new AssignmentReconcilerError(
        "assignment_invariant",
        "Active turn did not have exactly one active execution command",
        false,
      );
    }
    const executeCommand = executeCommands[0]!;
    const executeOutbox = await transaction
      .selectFrom("outbox")
      .select(["id", "published_at"])
      .where("tenant_id", "=", session.tenant_id)
      .where(sql<boolean>`${sql.ref("payload")} ->> 'commandId' = ${executeCommand.id}`)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const safelyUnacknowledged =
      executeCommand.state === "dispatched" &&
      turn.state === "dispatching" &&
      (session.state === "cold" || session.state === "idle") &&
      executeOutbox.published_at === null &&
      commands.length === 1;
    if (safelyUnacknowledged) {
      await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(executeCommand.state, "pending"),
          failure_code: null,
        })
        .where("id", "=", executeCommand.id)
        .where("state", "=", executeCommand.state)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({ state: transitionTurn(turn.state, "queued") })
        .where("id", "=", turn.id)
        .where("state", "=", turn.state)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("outbox")
        .set({ available_at: now, last_error: ASSIGNMENT_LOST })
        .where("id", "=", executeOutbox.id)
        .where("published_at", "is", null)
        .executeTakeFirstOrThrow();
      await this.#deleteLease(transaction, candidate);
      return "requeued";
    }

    if (!ACTIVE_SESSION_STATES.has(session.state) || !ACTIVE_TURN_STATES.has(turn.state)) {
      throw new AssignmentReconcilerError(
        "assignment_invariant",
        "Acknowledged assignment lifecycle was inconsistent",
        false,
      );
    }
    for (const command of commands) {
      if (!NONTERMINAL_COMMAND_STATES.has(command.state)) continue;
      await transaction
        .updateTable("commands")
        .set({
          state: transitionCommand(command.state, "failed"),
          completed_at: now,
          failure_code: ASSIGNMENT_LOST,
        })
        .where("id", "=", command.id)
        .where("state", "=", command.state)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("outbox")
        .set({
          published_at: sql<Date>`coalesce(${sql.ref("published_at")}, ${now})`,
          last_error: ASSIGNMENT_LOST,
        })
        .where("tenant_id", "=", session.tenant_id)
        .where(sql<boolean>`${sql.ref("payload")} ->> 'commandId' = ${command.id}`)
        .execute();
    }
    await transaction
      .updateTable("approvals")
      .set({
        state: transitionApproval("pending", "cancelled"),
        outcome: "cancelled",
        resolved_at: now,
      })
      .where("turn_id", "=", turn.id)
      .where("state", "=", "pending")
      .execute();
    const agentNodes = await transaction
      .selectFrom("agent_nodes")
      .select(["id", "state"])
      .where("session_id", "=", candidate.sessionId)
      .where("state", "in", ["pending", "running", "waiting", "cancelling"])
      .forUpdate()
      .execute();
    for (const node of agentNodes) {
      await transaction
        .updateTable("agent_nodes")
        .set({ state: transitionAgentNode(node.state, "failed"), settled_at: now })
        .where("id", "=", node.id)
        .where("state", "=", node.state)
        .executeTakeFirstOrThrow();
    }
    await transaction
      .updateTable("turns")
      .set({
        state: transitionTurn(turn.state, "failed"),
        failure_code: ASSIGNMENT_LOST,
        failure_message: ASSIGNMENT_LOST_MESSAGE,
        failure_retryable: false,
        settled_at: now,
      })
      .where("id", "=", turn.id)
      .where("state", "=", turn.state)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("sessions")
      .set({
        state: transitionSession(session.state, "failed"),
        row_version: sql<string>`${sql.ref("row_version")} + 1`,
        updated_at: now,
        last_active_at: now,
      })
      .where("id", "=", candidate.sessionId)
      .where("state", "=", session.state)
      .executeTakeFirstOrThrow();
    await this.#deleteLease(transaction, candidate);
    return "settled";
  }

  async #deleteLease(
    transaction: Transaction<Database>,
    assignment: DurableAssignment,
  ): Promise<void> {
    const deleted = await transaction
      .deleteFrom("session_leases")
      .where("session_id", "=", assignment.sessionId)
      .where("lease_id", "=", assignment.leaseId)
      .where("sandbox_id", "=", this.#sandboxId)
      .where("fencing_token", "=", String(assignment.fencingToken))
      .executeTakeFirst();
    if (deleted.numDeletedRows !== 1n) {
      throw new AssignmentReconcilerError(
        "stale_assignment",
        "Assignment changed while it was being reconciled",
        true,
      );
    }
  }

  async #synchronizeCapacity(transaction: Transaction<Database>, now: Date): Promise<void> {
    const sandbox = await transaction
      .selectFrom("sandboxes")
      .select(["state"])
      .where("id", "=", this.#sandboxId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const remaining = await transaction
      .selectFrom("session_leases")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("sandbox_id", "=", this.#sandboxId)
      .executeTakeFirstOrThrow();
    const activeSessions = safeInteger(remaining.count, "sandbox active assignment count");
    let nextState = sandbox.state;
    if (sandbox.state === "ready" && activeSessions > 0) {
      nextState = transitionSandbox(sandbox.state, "leased");
    } else if (sandbox.state === "leased" && activeSessions === 0) {
      nextState = transitionSandbox(sandbox.state, "ready");
    }
    await transaction
      .updateTable("sandboxes")
      .set({ state: nextState, active_sessions: activeSessions, updated_at: now })
      .where("id", "=", this.#sandboxId)
      .where("state", "=", sandbox.state)
      .executeTakeFirstOrThrow();
  }

  async #beginRetirement(now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", this.#sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (sandbox === undefined) {
        throw new AssignmentReconcilerError(
          "sandbox_unavailable",
          "Retirement sandbox was unavailable",
          false,
        );
      }
      if (
        sandbox.state === "terminated" ||
        sandbox.state === "draining" ||
        sandbox.state === "failed"
      ) {
        return;
      }
      const nextState =
        sandbox.state === "provisioning"
          ? transitionSandbox(sandbox.state, "failed")
          : transitionSandbox(sandbox.state, "draining");
      await transaction
        .updateTable("sandboxes")
        .set({ state: nextState, updated_at: now })
        .where("id", "=", this.#sandboxId)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    });
  }

  async #quarantineSandbox(now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", this.#sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (sandbox === undefined || sandbox.state === "failed" || sandbox.state === "terminated") {
        return;
      }
      await transaction
        .updateTable("sandboxes")
        .set({ state: transitionSandbox(sandbox.state, "failed"), updated_at: now })
        .where("id", "=", this.#sandboxId)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    });
  }

  #normalizeError(error: unknown): AssignmentReconcilerError {
    if (error instanceof AssignmentReconcilerError) return error;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      "retryable" in error &&
      typeof error.retryable === "boolean"
    ) {
      return new AssignmentReconcilerError(
        error.code,
        "Sandbox assignment reconciliation failed",
        error.retryable,
      );
    }
    return new AssignmentReconcilerError(
      "assignment_reconciliation_failed",
      "Sandbox assignment reconciliation failed",
      true,
    );
  }
}
