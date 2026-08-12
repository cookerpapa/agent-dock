import type { Database, ExecutionCellState } from "@agent-dock/database";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";

const TERMINAL_RUN_STATES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "superseded",
] as const;
const LIVE_ACTIVATION_STATES = ["reserved", "materializing", "active", "warm", "cleaning"] as const;

export type WorkspaceCellMigrationInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  targetCellId: string;
  requestedByUserId: string;
  idempotencyKey: string;
}>;

export type WorkspaceCellMigrationResult = Readonly<{
  migrationId: string;
  tenantId: string;
  workspaceId: string;
  sourceCellId: string;
  targetCellId: string;
  workspaceVersionId: string | null;
  baseRowVersion: number;
  resultRowVersion: number;
  idempotent: boolean;
}>;

export type WorkspaceCellMigrationServiceOptions = Readonly<{
  database: Kysely<Database>;
  idGenerator?: () => string;
  clock?: () => Date;
}>;

export class WorkspaceCellMigrationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "WorkspaceCellMigrationError";
    this.code = code;
    this.retryable = retryable;
  }
}

function bounded(value: string, name: string, maximum = 255): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function validDate(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new TypeError("Workspace Cell migration clock returned an invalid date");
  }
  return now;
}

type MigrationFailure = Readonly<{ code: string; message: string; retryable: boolean }>;

export class WorkspaceCellMigrationService {
  readonly #database: Kysely<Database>;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(options: WorkspaceCellMigrationServiceOptions) {
    this.#database = options.database;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  async setCellState(cellId: string, state: ExecutionCellState): Promise<void> {
    bounded(cellId, "cellId", 64);
    if (state !== "active" && state !== "draining" && state !== "disabled") {
      throw new TypeError("state is invalid");
    }
    const now = validDate(this.#clock);
    const failure = await this.#database.transaction().execute(async (transaction) => {
      const cell = await transaction
        .selectFrom("execution_cells")
        .select(["state", "assigned_workspaces"])
        .where("id", "=", cellId)
        .forUpdate()
        .executeTakeFirst();
      if (cell === undefined)
        return {
          code: "cell_not_found",
          message: "Execution Cell was not found",
          retryable: false,
        };
      if (state === "disabled" && safeInteger(cell.assigned_workspaces, "assignedWorkspaces") > 0) {
        return {
          code: "cell_not_empty",
          message: "Execution Cell still owns Workspaces",
          retryable: true,
        };
      }
      await transaction
        .updateTable("execution_cells")
        .set({ state, updated_at: now })
        .where("id", "=", cellId)
        .executeTakeFirstOrThrow();
      return undefined;
    });
    if (failure !== undefined) {
      throw new WorkspaceCellMigrationError(failure.code, failure.message, failure.retryable);
    }
  }

  async listWorkspaceIds(
    cellId: string,
  ): Promise<readonly { tenantId: string; workspaceId: string }[]> {
    bounded(cellId, "cellId", 64);
    const rows = await this.#database
      .selectFrom("workspaces")
      .select(["tenant_id", "id"])
      .where("cell_id", "=", cellId)
      .orderBy("tenant_id", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => ({ tenantId: row.tenant_id, workspaceId: row.id }));
  }

  async migrate(input: WorkspaceCellMigrationInput): Promise<WorkspaceCellMigrationResult> {
    const migrationId = this.#idGenerator();
    const now = validDate(this.#clock);
    const normalized = {
      tenantId: bounded(input.tenantId, "tenantId", 64),
      workspaceId: bounded(input.workspaceId, "workspaceId", 64),
      targetCellId: bounded(input.targetCellId, "targetCellId", 64),
      requestedByUserId: bounded(input.requestedByUserId, "requestedByUserId", 64),
      idempotencyKey: bounded(input.idempotencyKey, "idempotencyKey"),
    };
    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const existingBeforeLock = await transaction
        .selectFrom("workspace_cell_migrations")
        .selectAll()
        .where("tenant_id", "=", normalized.tenantId)
        .where("idempotency_key", "=", normalized.idempotencyKey)
        .executeTakeFirst();
      if (existingBeforeLock !== undefined) {
        return { result: this.#existingResult(existingBeforeLock, normalized) } as const;
      }
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["cell_id", "current_workspace_version_id", "row_version"])
        .where("tenant_id", "=", normalized.tenantId)
        .where("id", "=", normalized.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (workspace === undefined) {
        throw new WorkspaceCellMigrationError(
          "workspace_not_found",
          "Workspace was not found",
          false,
        );
      }
      const baseRowVersion = safeInteger(workspace.row_version, "workspaceRowVersion");
      const existingAfterLock = await transaction
        .selectFrom("workspace_cell_migrations")
        .selectAll()
        .where("tenant_id", "=", normalized.tenantId)
        .where("idempotency_key", "=", normalized.idempotencyKey)
        .executeTakeFirst();
      if (existingAfterLock !== undefined) {
        return { result: this.#existingResult(existingAfterLock, normalized) } as const;
      }
      await transaction
        .insertInto("workspace_cell_migrations")
        .values({
          id: migrationId,
          tenant_id: normalized.tenantId,
          workspace_id: normalized.workspaceId,
          source_cell_id: workspace.cell_id,
          target_cell_id: normalized.targetCellId,
          requested_by_user_id: normalized.requestedByUserId,
          idempotency_key: normalized.idempotencyKey,
          state: "requested",
          workspace_version_id: workspace.current_workspace_version_id,
          base_row_version: baseRowVersion,
          result_row_version: null,
          failure_code: null,
          settled_at: null,
        })
        .onConflict((conflict) => conflict.columns(["tenant_id", "idempotency_key"]).doNothing())
        .executeTakeFirst();
      const operation = await transaction
        .selectFrom("workspace_cell_migrations")
        .selectAll()
        .where("tenant_id", "=", normalized.tenantId)
        .where("idempotency_key", "=", normalized.idempotencyKey)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (operation.id !== migrationId) {
        return { result: this.#existingResult(operation, normalized) } as const;
      }
      const failure = await this.#validateMigration(
        transaction,
        normalized.tenantId,
        normalized.workspaceId,
        workspace.cell_id,
        normalized.targetCellId,
        workspace.current_workspace_version_id,
      );
      if (failure !== undefined) {
        await transaction
          .updateTable("workspace_cell_migrations")
          .set({ state: "failed", failure_code: failure.code, settled_at: now })
          .where("id", "=", migrationId)
          .executeTakeFirstOrThrow();
        return { failure } as const;
      }
      const resultRowVersion = baseRowVersion + 1;
      const updated = await transaction
        .updateTable("workspaces")
        .set({
          cell_id: normalized.targetCellId,
          row_version: resultRowVersion,
          updated_at: now,
        })
        .where("tenant_id", "=", normalized.tenantId)
        .where("id", "=", normalized.workspaceId)
        .where("cell_id", "=", workspace.cell_id)
        .where("row_version", "=", String(baseRowVersion))
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new WorkspaceCellMigrationError(
          "workspace_fence_conflict",
          "Workspace changed while its Cell route was being migrated",
          true,
        );
      }
      await transaction
        .updateTable("sessions")
        .set({
          worker_affinity_sandbox_id: null,
          worker_affinity_expires_at: null,
          updated_at: now,
        })
        .where("tenant_id", "=", normalized.tenantId)
        .where("workspace_id", "=", normalized.workspaceId)
        .execute();
      const source = await transaction
        .updateTable("execution_cells")
        .set({
          assigned_workspaces: sql<string>`${sql.ref("assigned_workspaces")} - 1`,
          updated_at: now,
        })
        .where("id", "=", workspace.cell_id)
        .where("assigned_workspaces", ">", "0")
        .executeTakeFirst();
      const target = await transaction
        .updateTable("execution_cells")
        .set({
          assigned_workspaces: sql<string>`${sql.ref("assigned_workspaces")} + 1`,
          updated_at: now,
        })
        .where("id", "=", normalized.targetCellId)
        .where("state", "=", "active")
        .executeTakeFirst();
      if (source.numUpdatedRows !== 1n || target.numUpdatedRows !== 1n) {
        throw new WorkspaceCellMigrationError(
          "cell_capacity_conflict",
          "Execution Cell capacity changed during migration",
          true,
        );
      }
      await transaction
        .updateTable("workspace_cell_migrations")
        .set({
          state: "completed",
          result_row_version: resultRowVersion,
          settled_at: now,
        })
        .where("id", "=", migrationId)
        .executeTakeFirstOrThrow();
      return {
        result: {
          migrationId,
          tenantId: normalized.tenantId,
          workspaceId: normalized.workspaceId,
          sourceCellId: workspace.cell_id,
          targetCellId: normalized.targetCellId,
          workspaceVersionId: workspace.current_workspace_version_id,
          baseRowVersion,
          resultRowVersion,
          idempotent: false,
        },
      } as const;
    });
    if ("failure" in outcome) {
      throw new WorkspaceCellMigrationError(
        outcome.failure.code,
        outcome.failure.message,
        outcome.failure.retryable,
      );
    }
    return outcome.result;
  }

  #existingResult(
    operation: {
      id: string;
      tenant_id: string;
      workspace_id: string;
      source_cell_id: string;
      target_cell_id: string;
      state: "requested" | "completed" | "failed";
      workspace_version_id: string | null;
      base_row_version: string;
      result_row_version: string | null;
      failure_code: string | null;
    },
    input: { workspaceId: string; targetCellId: string },
  ): WorkspaceCellMigrationResult {
    if (
      operation.workspace_id !== input.workspaceId ||
      operation.target_cell_id !== input.targetCellId
    ) {
      throw new WorkspaceCellMigrationError(
        "idempotency_conflict",
        "Migration idempotency key was reused with different input",
        false,
      );
    }
    if (operation.state === "failed") {
      throw new WorkspaceCellMigrationError(
        operation.failure_code ?? "migration_failed",
        "The prior Workspace Cell migration failed",
        true,
      );
    }
    if (operation.state !== "completed" || operation.result_row_version === null) {
      throw new WorkspaceCellMigrationError(
        "migration_in_progress",
        "Workspace Cell migration is still in progress",
        true,
      );
    }
    return {
      migrationId: operation.id,
      tenantId: operation.tenant_id,
      workspaceId: operation.workspace_id,
      sourceCellId: operation.source_cell_id,
      targetCellId: operation.target_cell_id,
      workspaceVersionId: operation.workspace_version_id,
      baseRowVersion: safeInteger(operation.base_row_version, "baseRowVersion"),
      resultRowVersion: safeInteger(operation.result_row_version, "resultRowVersion"),
      idempotent: true,
    };
  }

  async #validateMigration(
    transaction: Transaction<Database>,
    tenantId: string,
    workspaceId: string,
    sourceCellId: string,
    targetCellId: string,
    workspaceVersionId: string | null,
  ): Promise<MigrationFailure | undefined> {
    if (sourceCellId === targetCellId) {
      return {
        code: "cell_unchanged",
        message: "Workspace already belongs to the target Cell",
        retryable: false,
      };
    }
    const cells = await transaction
      .selectFrom("execution_cells")
      .select(["id", "state", "sandbox_domain_id"])
      .where("id", "in", [sourceCellId, targetCellId].sort())
      .orderBy("id", "asc")
      .forUpdate()
      .execute();
    if (cells.length !== 2) {
      return {
        code: "cell_not_found",
        message: "Source or target Cell was not found",
        retryable: false,
      };
    }
    if (cells.find((cell) => cell.id === targetCellId)?.state !== "active") {
      return {
        code: "target_cell_unavailable",
        message: "Target Cell is not active",
        retryable: true,
      };
    }
    const sourceDomain = cells.find((cell) => cell.id === sourceCellId)?.sandbox_domain_id;
    const targetDomain = cells.find((cell) => cell.id === targetCellId)?.sandbox_domain_id;
    if (sourceDomain !== targetDomain) {
      return {
        code: "sandbox_domain_migration_required",
        message: "Cross-Domain Workspace migration requires a dedicated storage transfer",
        retryable: false,
      };
    }
    const activeRun = await transaction
      .selectFrom("runs")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("workspace_id", "=", workspaceId)
      .where("state", "not in", TERMINAL_RUN_STATES)
      .limit(1)
      .executeTakeFirst();
    if (activeRun !== undefined) {
      return {
        code: "workspace_run_active",
        message: "Workspace still has an unsettled Run",
        retryable: true,
      };
    }
    const activation = await transaction
      .selectFrom("tool_broker_activations")
      .select("activation_id")
      .where("tenant_id", "=", tenantId)
      .where("workspace_id", "=", workspaceId)
      .where("state", "in", LIVE_ACTIVATION_STATES)
      .limit(1)
      .executeTakeFirst();
    if (activation !== undefined) {
      return {
        code: "workspace_runtime_active",
        message: "Workspace still has a live Tool runtime",
        retryable: true,
      };
    }
    const importing = await transaction
      .selectFrom("workspace_sources")
      .select("workspace_id")
      .where("tenant_id", "=", tenantId)
      .where("workspace_id", "=", workspaceId)
      .where("status", "in", ["pending", "importing"])
      .executeTakeFirst();
    if (importing !== undefined) {
      return {
        code: "workspace_import_active",
        message: "Workspace import is not settled",
        retryable: true,
      };
    }
    if (workspaceVersionId !== null) {
      const version = await transaction
        .selectFrom("workspace_versions")
        .innerJoin("artifacts", "artifacts.id", "workspace_versions.workspace_artifact_id")
        .select(["workspace_versions.state", "artifacts.kind"])
        .where("workspace_versions.tenant_id", "=", tenantId)
        .where("workspace_versions.workspace_id", "=", workspaceId)
        .where("workspace_versions.id", "=", workspaceVersionId)
        .executeTakeFirst();
      if (version?.state !== "settled" || version.kind !== "workspace_snapshot") {
        return {
          code: "workspace_checkpoint_unsettled",
          message: "Workspace checkpoint is not committed",
          retryable: true,
        };
      }
    }
    return undefined;
  }
}
