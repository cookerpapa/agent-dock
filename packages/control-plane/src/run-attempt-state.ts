import type { Database } from "@agent-dock/database";
import {
  isTerminalRunAttemptState,
  isTerminalRunState,
  transitionRun,
  transitionRunAttempt,
  type RunAttemptState,
  type RunState,
} from "@agent-dock/domain";
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";

export class RunAttemptLifecycleError extends Error {
  readonly code: string;
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunAttemptLifecycleError";
    this.code = code;
  }
}

export type CurrentRunAttemptIdentity = {
  tenantId: string;
  runId: string;
  attemptId: string;
  leaseId?: string;
  fencingToken?: number;
};

export type RunAttemptFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export type RunAttemptTransitionInput = {
  runState: RunState;
  attemptState: RunAttemptState;
  reason: string;
  now: Date;
  failure?: RunAttemptFailure;
  stopReason?: string;
  checkpointRevision?: string;
  claimExpiresAt?: Date;
  heartbeat?: boolean;
  transitionId?: string;
};

function expectOne(value: bigint, description: string): void {
  if (value !== 1n) {
    throw new RunAttemptLifecycleError(
      "run_attempt_stale",
      `${description} changed ${String(value)} rows`,
    );
  }
}

function validReason(value: string): string {
  if (value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Run attempt transition reason is invalid");
  }
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value;
}

function phaseTimestamp(state: RunAttemptState, now: Date): Record<string, Date> {
  switch (state) {
    case "provisioning":
      return { provisioning_at: now };
    case "restoring":
      return { restoring_at: now };
    case "running":
      return { running_at: now };
    case "checkpointing":
      return { checkpointing_at: now };
    default:
      return {};
  }
}

export async function transitionCurrentRunAttempt(
  transaction: Transaction<Database>,
  identity: CurrentRunAttemptIdentity,
  input: RunAttemptTransitionInput,
): Promise<void> {
  const now = validDate(input.now, "Run attempt transition clock");
  const reason = validReason(input.reason);
  if (input.checkpointRevision !== undefined && !/^[0-9a-f]{64}$/.test(input.checkpointRevision)) {
    throw new TypeError("Run attempt checkpoint revision is invalid");
  }
  const row = await transaction
    .selectFrom("runs as run")
    .innerJoin("run_attempts as attempt", (join) =>
      join
        .onRef("attempt.run_id", "=", "run.id")
        .onRef("attempt.id", "=", "run.current_attempt_id"),
    )
    .innerJoin("sessions as session_row", (join) =>
      join
        .onRef("session_row.tenant_id", "=", "run.tenant_id")
        .onRef("session_row.id", "=", "run.session_id"),
    )
    .select([
      "run.state as runState",
      "run.row_version as runVersion",
      "run.current_attempt_id as currentAttemptId",
      "run.workspace_id as workspaceId",
      "run.workspace_base_version_id as workspaceBaseVersionId",
      "session_row.forked_from_session_id as forkedFromSessionId",
      "attempt.state as attemptState",
      "attempt.lease_id as leaseId",
      "attempt.fencing_token as fencingToken",
    ])
    .where("run.tenant_id", "=", identity.tenantId)
    .where("run.id", "=", identity.runId)
    .where("attempt.id", "=", identity.attemptId)
    .forUpdate(["run", "attempt"])
    .executeTakeFirst();
  if (row === undefined || row.currentAttemptId !== identity.attemptId) {
    throw new RunAttemptLifecycleError("run_attempt_stale", "Run attempt is no longer current");
  }
  if (
    (identity.leaseId !== undefined && row.leaseId !== identity.leaseId) ||
    (identity.fencingToken !== undefined && Number(row.fencingToken) !== identity.fencingToken)
  ) {
    throw new RunAttemptLifecycleError("run_attempt_stale", "Run attempt lease authority is stale");
  }

  const runState =
    row.runState === input.runState ? row.runState : transitionRun(row.runState, input.runState);
  const attemptState =
    row.attemptState === input.attemptState
      ? row.attemptState
      : transitionRunAttempt(row.attemptState, input.attemptState);
  const terminalRun = isTerminalRunState(runState);
  const terminalAttempt = isTerminalRunAttemptState(attemptState);
  const failureRequired = runState === "failed" || runState === "timed_out";
  if (failureRequired !== (input.failure !== undefined)) {
    throw new TypeError("Run failure metadata does not match its target state");
  }

  const attemptUpdate = await transaction
    .updateTable("run_attempts")
    .set({
      state: attemptState,
      ...phaseTimestamp(attemptState, now),
      ...(input.claimExpiresAt === undefined ? {} : { claim_expires_at: input.claimExpiresAt }),
      ...(input.heartbeat === true ? { last_heartbeat_at: now } : {}),
      ...(input.checkpointRevision === undefined
        ? {}
        : { checkpoint_revision: input.checkpointRevision }),
      failure_code: input.failure?.code ?? null,
      failure_message: input.failure?.message ?? null,
      failure_retryable: input.failure?.retryable ?? null,
      settled_at: terminalAttempt ? now : null,
      updated_at: now,
    })
    .where("tenant_id", "=", identity.tenantId)
    .where("run_id", "=", identity.runId)
    .where("id", "=", identity.attemptId)
    .where("state", "=", row.attemptState)
    .executeTakeFirst();
  expectOne(attemptUpdate.numUpdatedRows, "Updating a run attempt");

  const runUpdate = await transaction
    .updateTable("runs")
    .set({
      state: runState,
      ...(runState === "provisioning" ||
      runState === "restoring" ||
      runState === "running" ||
      runState === "checkpointing" ||
      runState === "cancel_requested"
        ? { started_at: sql<Date>`coalesce(${sql.ref("started_at")}, ${now})` }
        : {}),
      stop_reason: input.stopReason ?? null,
      failure_code: input.failure?.code ?? null,
      failure_message: input.failure?.message ?? null,
      failure_retryable: input.failure?.retryable ?? null,
      settled_at: terminalRun ? now : null,
      row_version: sql<string>`${sql.ref("row_version")} + 1`,
      updated_at: now,
    })
    .where("tenant_id", "=", identity.tenantId)
    .where("id", "=", identity.runId)
    .where("current_attempt_id", "=", identity.attemptId)
    .where("state", "=", row.runState)
    .where("row_version", "=", row.runVersion)
    .executeTakeFirst();
  expectOne(runUpdate.numUpdatedRows, "Updating a run");

  if (terminalRun) {
    if (runState === "completed") {
      const version = await transaction
        .updateTable("workspace_versions")
        .set({ state: "settled", settled_at: now })
        .where("tenant_id", "=", identity.tenantId)
        .where("run_id", "=", identity.runId)
        .where("attempt_id", "=", identity.attemptId)
        .where("state", "=", "staged")
        .returning([
          "id",
          "workspace_id",
          "session_id",
          "pi_artifact_id",
          "workspace_artifact_id",
        ])
        .executeTakeFirst();
      if (version !== undefined) {
        await transaction
          .updateTable("test_results")
          .set({ workspace_version_id: version.id })
          .where("tenant_id", "=", identity.tenantId)
          .where("run_id", "=", identity.runId)
          .execute();
        const artifacts = await transaction
          .selectFrom("artifacts")
          .select(["id", "object_key"])
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "in", [version.pi_artifact_id, version.workspace_artifact_id])
          .execute();
        const piKey = artifacts.find(
          (artifact) => artifact.id === version.pi_artifact_id,
        )?.object_key;
        const workspaceKey = artifacts.find(
          (artifact) => artifact.id === version.workspace_artifact_id,
        )?.object_key;
        if (piKey === undefined || workspaceKey === undefined) {
          throw new RunAttemptLifecycleError(
            "workspace_version_corrupt",
            "Settled Workspace version artifacts are missing",
          );
        }
        if (row.forkedFromSessionId === null) {
          let workspaceUpdate = transaction
            .updateTable("workspaces")
            .set({
              current_workspace_version_id: version.id,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
              updated_at: now,
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("id", "=", version.workspace_id);
          workspaceUpdate =
            row.workspaceBaseVersionId === null
              ? workspaceUpdate.where("current_workspace_version_id", "is", null)
              : workspaceUpdate.where(
                  "current_workspace_version_id",
                  "=",
                  row.workspaceBaseVersionId,
                );
          const workspaceHead = await workspaceUpdate.executeTakeFirst();
          expectOne(workspaceHead.numUpdatedRows, "Advancing the shared Workspace head");

          await transaction
            .updateTable("sessions")
            .set({
              current_workspace_version_id: version.id,
              workspace_snapshot_key: workspaceKey,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
              updated_at: now,
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("workspace_id", "=", version.workspace_id)
            .where("forked_from_session_id", "is", null)
            .execute();
        }
        const conversationUpdate = await transaction
          .updateTable("sessions")
          .set({
            current_workspace_version_id: version.id,
            pi_session_snapshot_key: piKey,
            workspace_snapshot_key: workspaceKey,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", version.session_id)
          .executeTakeFirst();
        expectOne(conversationUpdate.numUpdatedRows, "Advancing the Pi conversation checkpoint");
      }
    } else {
      await transaction
        .updateTable("workspace_versions")
        .set({ state: "abandoned" })
        .where("tenant_id", "=", identity.tenantId)
        .where("run_id", "=", identity.runId)
        .where("attempt_id", "=", identity.attemptId)
        .where("state", "=", "staged")
        .execute();
      const session = await transaction
        .selectFrom("sessions as session_row")
        .leftJoin(
          "workspace_versions as version",
          "version.id",
          "session_row.current_workspace_version_id",
        )
        .leftJoin("artifacts as version_pi", "version_pi.id", "version.pi_artifact_id")
        .leftJoin("artifacts as workspace", "workspace.id", "version.workspace_artifact_id")
        .select([
          "session_row.id",
          "session_row.current_workspace_version_id as currentVersionId",
          "version_pi.object_key as versionPiKey",
          "workspace.object_key as workspaceKey",
        ])
        .where("session_row.tenant_id", "=", identity.tenantId)
        .where(
          "session_row.id",
          "=",
          sql<string>`(select session_id from runs where id = ${identity.runId})`,
        )
        .executeTakeFirst();
      if (session !== undefined) {
        if (session.currentVersionId !== null && session.workspaceKey === null) {
          throw new RunAttemptLifecycleError(
            "workspace_version_corrupt",
            "Current Workspace version artifact is missing",
          );
        }
        const priorPi = await transaction
          .selectFrom("artifacts as artifact")
          .innerJoin("turns as turn", (join) =>
            join
              .onRef("turn.tenant_id", "=", "artifact.tenant_id")
              .onRef("turn.session_id", "=", "artifact.session_id")
              .onRef("turn.id", "=", "artifact.turn_id"),
          )
          .select("artifact.object_key as objectKey")
          .where("artifact.tenant_id", "=", identity.tenantId)
          .where("artifact.session_id", "=", session.id)
          .where("artifact.kind", "=", "pi_session_snapshot")
          .where("artifact.run_id", "!=", identity.runId)
          .where("turn.state", "=", "completed")
          .orderBy("turn.settled_at", "desc")
          .orderBy("artifact.created_at", "desc")
          .executeTakeFirst();
        await transaction
          .updateTable("sessions")
          .set({
            pi_session_snapshot_key: priorPi?.objectKey ?? session.versionPiKey,
            workspace_snapshot_key: session.workspaceKey,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", session.id)
          .executeTakeFirstOrThrow();
      }
    }
  }

  if (row.attemptState !== attemptState) {
    await transaction
      .insertInto("run_attempt_transitions")
      .values({
        id: input.transitionId ?? randomUUID(),
        tenant_id: identity.tenantId,
        run_id: identity.runId,
        attempt_id: identity.attemptId,
        from_state: row.attemptState,
        to_state: attemptState,
        reason,
        occurred_at: now,
      })
      .executeTakeFirstOrThrow();
  }
}
