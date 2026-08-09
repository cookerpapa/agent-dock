import type {
  Database,
  SandboxManagerActivationState,
  SandboxManagerOperationState,
} from "@agent-dock/database";
import type { SupervisorRuntimeAssignment, ToolSandboxAssignment } from "@agent-dock/protocol";
import type { SandboxHandle } from "./sandbox-provider.ts";
import type { Kysely, Transaction } from "kysely";

export type SandboxActivationReservation = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  capabilitySha256: string;
  turnContextSha256: string;
  attemptContextSha256: string;
  environmentSha256: string;
  workspaceRevision?: string;
};

export type SandboxActivationReservationResult =
  { status: "reserved" } | { status: "redirect"; ownerBaseUrl: string } | { status: "busy" };

export type SandboxOrphanedActivation = Readonly<{
  activationId: string;
  assignment: ToolSandboxAssignment;
}>;

export interface SandboxActivationStateRepository {
  start(): Promise<void>;
  checkHealth(): Promise<void>;
  reserve(input: SandboxActivationReservation): Promise<SandboxActivationReservationResult>;
  setActivationState(
    activationId: string,
    state: SandboxManagerActivationState,
    detail?: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string },
  ): Promise<void>;
  beginOperation(
    activationId: string,
    operationId: string,
    requestSha256: string,
  ): Promise<"started" | "unknown">;
  settleOperation(
    operationId: string,
    state: Exclude<SandboxManagerOperationState, "running">,
    failureCode?: string,
  ): Promise<void>;
  claimOrphanedActivations(limit: number): Promise<readonly SandboxOrphanedActivation[]>;
  listRetiredWarmActivationIds(): Promise<readonly string[]>;
  listRuntimeAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]>;
  releaseRuntimeAssignment(assignment: SupervisorRuntimeAssignment): Promise<void>;
  close(): Promise<void>;
}

export class SandboxActivationStateRepositoryError extends Error {
  readonly code: "ownership_lost" | "state_conflict" | "unavailable";

  constructor(code: SandboxActivationStateRepositoryError["code"], message: string) {
    super(message);
    this.name = "SandboxActivationStateRepositoryError";
    this.code = code;
  }
}

export class InMemorySandboxActivationStateRepository implements SandboxActivationStateRepository {
  readonly #operations = new Map<string, string>();

  async start(): Promise<void> {}
  async checkHealth(): Promise<void> {}
  async reserve(): Promise<SandboxActivationReservationResult> {
    return { status: "reserved" };
  }
  async setActivationState(): Promise<void> {}
  async beginOperation(
    _activationId: string,
    operationId: string,
    requestSha256: string,
  ): Promise<"started" | "unknown"> {
    const existing = this.#operations.get(operationId);
    if (existing !== undefined) return "unknown";
    this.#operations.set(operationId, requestSha256);
    return "started";
  }
  async settleOperation(): Promise<void> {}
  async claimOrphanedActivations(): Promise<readonly SandboxOrphanedActivation[]> {
    return [];
  }
  async listRetiredWarmActivationIds(): Promise<readonly string[]> {
    return [];
  }
  async listRuntimeAssignments(): Promise<readonly SupervisorRuntimeAssignment[]> {
    return [];
  }
  async releaseRuntimeAssignment(): Promise<void> {}
  async close(): Promise<void> {}
}

export type PostgresSandboxActivationStateRepositoryOptions = {
  database: Kysely<Database>;
  cellId: string;
  instanceId: string;
  ownerBaseUrl: string;
  leaseMs?: number;
  heartbeatMs?: number;
  clock?: () => Date;
};

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Sandbox Manager state clock returned an invalid date");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function failureCode(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "sandbox_manager_failed";
}

export class PostgresSandboxActivationStateRepository implements SandboxActivationStateRepository {
  readonly #database: Kysely<Database>;
  readonly #cellId: string;
  readonly #instanceId: string;
  readonly #ownerBaseUrl: string;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #clock: () => Date;
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: PostgresSandboxActivationStateRepositoryOptions) {
    this.#database = options.database;
    this.#cellId = options.cellId;
    this.#instanceId = options.instanceId;
    this.#ownerBaseUrl = new URL(options.ownerBaseUrl).toString();
    this.#leaseMs = positiveInteger(options.leaseMs ?? 15_000, "leaseMs");
    this.#heartbeatMs = positiveInteger(options.heartbeatMs ?? 5_000, "heartbeatMs");
    if (this.#heartbeatMs * 2 >= this.#leaseMs) {
      throw new TypeError("Sandbox Manager heartbeat must leave lease failure margin");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.#heartbeat !== undefined || this.#closed) {
      throw new Error("Sandbox Manager state repository can only start once");
    }
    const now = validDate(this.#clock);
    const leaseExpiresAt = new Date(now.valueOf() + this.#leaseMs);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#markExpiredOwnersLost(transaction, now);
      await transaction
        .insertInto("sandbox_manager_instances")
        .values({
          instance_id: this.#instanceId,
          cell_id: this.#cellId,
          owner_base_url: this.#ownerBaseUrl,
          state: "ready",
          lease_expires_at: leaseExpiresAt,
          last_heartbeat_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
    });
    this.#heartbeat = setInterval(
      () => void this.#renew().catch(() => undefined),
      this.#heartbeatMs,
    );
    this.#heartbeat.unref();
  }

  async checkHealth(): Promise<void> {
    const now = validDate(this.#clock);
    const row = await this.#database
      .selectFrom("sandbox_manager_instances")
      .select("instance_id")
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", now)
      .executeTakeFirst();
    if (row === undefined) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Sandbox Manager database ownership lease is not current",
      );
    }
  }

  async reserve(input: SandboxActivationReservation): Promise<SandboxActivationReservationResult> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select("cell_id")
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("id", "=", input.assignment.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (workspace?.cell_id !== this.#cellId) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Workspace is not assigned to this execution Cell",
        );
      }
      const existing = await transaction
        .selectFrom("sandbox_manager_activations")
        .selectAll()
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("workspace_id", "=", input.assignment.workspaceId)
        .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
        .executeTakeFirst();
      if (existing !== undefined) {
        const reusable =
          existing.state === "warm" &&
          existing.session_id === input.assignment.sessionId &&
          existing.workspace_revision === (input.workspaceRevision ?? null) &&
          existing.environment_sha256 === input.environmentSha256;
        if (!reusable) return { status: "busy" };
        if (existing.owner_instance_id !== this.#instanceId) {
          return { status: "redirect", ownerBaseUrl: existing.owner_base_url };
        }
        if (existing.activation_id !== input.activationId) {
          throw new SandboxActivationStateRepositoryError(
            "state_conflict",
            "Warm activation identity changed inside one owner",
          );
        }
        await transaction
          .updateTable("sandbox_manager_activations")
          .set({
            turn_id: input.assignment.turnId,
            attempt_id: input.assignment.attemptId,
            lease_id: input.assignment.leaseId,
            fencing_token: input.assignment.fencingToken,
            capability_sha256: input.capabilitySha256,
            turn_context_sha256: input.turnContextSha256,
            attempt_context_sha256: input.attemptContextSha256,
            state: "reserved",
            failure_code: null,
            updated_at: now,
          })
          .where("activation_id", "=", input.activationId)
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "=", "warm")
          .executeTakeFirstOrThrow();
        return { status: "reserved" };
      }
      await transaction
        .insertInto("sandbox_manager_activations")
        .values({
          activation_id: input.activationId,
          cell_id: this.#cellId,
          owner_instance_id: this.#instanceId,
          owner_base_url: this.#ownerBaseUrl,
          tenant_id: input.assignment.tenantId,
          project_id: input.assignment.projectId,
          workspace_id: input.assignment.workspaceId,
          supervisor_id: input.assignment.supervisorId,
          boot_id: input.assignment.bootId,
          sandbox_id: input.assignment.sandboxId,
          command_id: input.assignment.commandId,
          session_id: input.assignment.sessionId,
          turn_id: input.assignment.turnId,
          attempt_id: input.assignment.attemptId,
          lease_id: input.assignment.leaseId,
          fencing_token: input.assignment.fencingToken,
          capability_sha256: input.capabilitySha256,
          turn_context_sha256: input.turnContextSha256,
          attempt_context_sha256: input.attemptContextSha256,
          environment_sha256: input.environmentSha256,
          workspace_revision: input.workspaceRevision ?? null,
          runtime_id: null,
          runtime_name: null,
          state: "reserved",
          failure_code: null,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      return { status: "reserved" };
    });
  }

  async setActivationState(
    activationId: string,
    state: SandboxManagerActivationState,
    detail: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("sandbox_manager_activations")
        .set({
          state,
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          ...(detail.workspaceRevision === undefined
            ? {}
            : { workspace_revision: detail.workspaceRevision }),
          failure_code: failureCode(detail.failureCode),
          updated_at: now,
        })
        .where("activation_id", "=", activationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .executeTakeFirst();
    });
    if (updated.numUpdatedRows !== 1n) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Sandbox activation ownership is no longer current",
      );
    }
  }

  async beginOperation(
    activationId: string,
    operationId: string,
    requestSha256: string,
  ): Promise<"started" | "unknown"> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const activation = await transaction
        .selectFrom("sandbox_manager_activations")
        .select("activation_id")
        .where("activation_id", "=", activationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["reserved", "materializing", "active"])
        .forUpdate()
        .executeTakeFirst();
      if (activation === undefined) {
        throw new SandboxActivationStateRepositoryError(
          "ownership_lost",
          "Sandbox activation is not executable by this owner",
        );
      }
      const existing = await transaction
        .selectFrom("sandbox_manager_operations")
        .select("operation_id")
        .where("operation_id", "=", operationId)
        .executeTakeFirst();
      if (existing !== undefined) return "unknown";
      await transaction
        .insertInto("sandbox_manager_operations")
        .values({
          operation_id: operationId,
          activation_id: activationId,
          owner_instance_id: this.#instanceId,
          request_sha256: requestSha256,
          state: "running",
          failure_code: null,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();
      return "started";
    });
  }

  async settleOperation(
    operationId: string,
    state: Exclude<SandboxManagerOperationState, "running">,
    code?: string,
  ): Promise<void> {
    const now = validDate(this.#clock);
    const settled = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("sandbox_manager_operations")
        .set({ state, failure_code: failureCode(code), settled_at: now })
        .where("operation_id", "=", operationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "running")
        .executeTakeFirst();
    });
    if (settled.numUpdatedRows !== 1n) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Sandbox operation ownership is no longer current",
      );
    }
  }

  async claimOrphanedActivations(limit: number): Promise<readonly SandboxOrphanedActivation[]> {
    const boundedLimit = positiveInteger(limit, "orphan cleanup limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("sandbox_manager_activations")
        .select([
          "activation_id",
          "tenant_id",
          "project_id",
          "workspace_id",
          "supervisor_id",
          "boot_id",
          "sandbox_id",
          "command_id",
          "session_id",
          "turn_id",
          "attempt_id",
          "lease_id",
          "fencing_token",
        ])
        .where("cell_id", "=", this.#cellId)
        .where("state", "=", "unknown")
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("sandbox_manager_activations")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            updated_at: now,
          })
          .where("activation_id", "=", row.activation_id)
          .where("state", "=", "unknown")
          .executeTakeFirstOrThrow();
      }
      return rows.map((row) => ({
        activationId: row.activation_id,
        assignment: {
          tenantId: row.tenant_id,
          projectId: row.project_id,
          workspaceId: row.workspace_id,
          supervisorId: row.supervisor_id,
          bootId: row.boot_id,
          sandboxId: row.sandbox_id,
          commandId: row.command_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          attemptId: row.attempt_id,
          leaseId: row.lease_id,
          fencingToken: Number(row.fencing_token),
        },
      }));
    });
  }

  async listRetiredWarmActivationIds(): Promise<readonly string[]> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("sandbox_manager_activations as activation")
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "activation.tenant_id")
            .onRef("session_row.id", "=", "activation.session_id"),
        )
        .select("activation.activation_id as activationId")
        .where("activation.owner_instance_id", "=", this.#instanceId)
        .where("activation.state", "=", "warm")
        .where("session_row.archived_at", "is not", null)
        .execute();
      return rows.map((row) => row.activationId);
    });
  }

  async listRuntimeAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const rows = await this.#database
      .selectFrom("sandbox_manager_activations")
      .select([
        "runtime_id",
        "runtime_name",
        "supervisor_id",
        "boot_id",
        "sandbox_id",
        "command_id",
        "workspace_id",
        "session_id",
        "turn_id",
        "lease_id",
        "fencing_token",
      ])
      .where("cell_id", "=", this.#cellId)
      .where("sandbox_id", "=", sandboxId)
      .where("state", "in", ["active", "warm"])
      .where("runtime_id", "is not", null)
      .where("runtime_name", "is not", null)
      .execute();
    return rows.map((row) => ({
      containerId: row.runtime_id!,
      containerName: row.runtime_name!,
      supervisorId: row.supervisor_id,
      bootId: row.boot_id,
      sandboxId: row.sandbox_id,
      commandId: row.command_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      leaseId: row.lease_id,
      fencingToken: Number(row.fencing_token),
    }));
  }

  async releaseRuntimeAssignment(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      await transaction
        .updateTable("sandbox_manager_activations")
        .set({ state: "released", failure_code: null, updated_at: now })
        .where("cell_id", "=", this.#cellId)
        .where("supervisor_id", "=", assignment.supervisorId)
        .where("boot_id", "=", assignment.bootId)
        .where("sandbox_id", "=", assignment.sandboxId)
        .where("command_id", "=", assignment.commandId)
        .where("workspace_id", "=", assignment.workspaceId)
        .where("session_id", "=", assignment.sessionId)
        .where("turn_id", "=", assignment.turnId)
        .where("lease_id", "=", assignment.leaseId)
        .where("fencing_token", "=", String(assignment.fencingToken))
        .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
        .execute();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("sandbox_manager_operations")
        .set({ state: "unknown", failure_code: "sandbox_manager_stopped", settled_at: now })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "running")
        .execute();
      await transaction
        .updateTable("sandbox_manager_activations")
        .set({ state: "unknown", failure_code: "sandbox_manager_stopped", updated_at: now })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
        .execute();
      await transaction
        .updateTable("sandbox_manager_instances")
        .set({ state: "stopped", lease_expires_at: now, updated_at: now })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .execute();
    });
  }

  async #renew(): Promise<void> {
    const now = validDate(this.#clock);
    const renewed = await this.#database.transaction().execute(async (transaction) => {
      await this.#markExpiredOwnersLost(transaction, now);
      return transaction
        .updateTable("sandbox_manager_instances")
        .set({
          last_heartbeat_at: now,
          lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
          updated_at: now,
        })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .where("lease_expires_at", ">", now)
        .executeTakeFirst();
    });
    if (renewed.numUpdatedRows !== 1n) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Sandbox Manager ownership heartbeat was fenced",
      );
    }
  }

  async #assertCurrentOwner(transaction: Transaction<Database>, now: Date): Promise<void> {
    const owner = await transaction
      .selectFrom("sandbox_manager_instances")
      .select("instance_id")
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", now)
      .executeTakeFirst();
    if (owner === undefined) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Sandbox Manager database ownership lease is not current",
      );
    }
  }

  async #markExpiredOwnersLost(transaction: Transaction<Database>, now: Date): Promise<void> {
    const lostInstances = await transaction
      .updateTable("sandbox_manager_instances")
      .set({ state: "lost", updated_at: now })
      .where("cell_id", "=", this.#cellId)
      .where("state", "=", "ready")
      .where("lease_expires_at", "<=", now)
      .returning("instance_id")
      .execute();
    const lostIds = lostInstances.map((instance) => instance.instance_id);
    if (lostIds.length === 0) return;
    await transaction
      .updateTable("sandbox_manager_operations")
      .set({ state: "unknown", failure_code: "sandbox_manager_owner_lost", settled_at: now })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "=", "running")
      .execute();
    await transaction
      .updateTable("sandbox_manager_activations")
      .set({ state: "unknown", failure_code: "sandbox_manager_owner_lost", updated_at: now })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
      .execute();
  }
}
