import type {
  Database,
  DevelopmentEnvironmentState,
  ToolBrokerActivationState,
  ToolBrokerOperationState,
  WorkspaceTerminalState,
} from "@pi-cloud/database";
import type { SupervisorRuntimeAssignment, ToolSandboxAssignment } from "@pi-cloud/protocol";
import type { SandboxHandle } from "./sandbox-provider.ts";
import { sql, type Kysely, type Transaction } from "kysely";

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
  | { status: "reserved" }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "tenant_capacity" }
  | { status: "capacity" };

export type SandboxOrphanedActivation = Readonly<{
  activationId: string;
  assignment: ToolSandboxAssignment;
}>;

export type WorkspaceTerminalReservation = Readonly<{
  terminalId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
}>;

export type WorkspaceTerminalReservationResult =
  | { status: "reserved"; retiredActivation?: SandboxOrphanedActivation }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "tenant_capacity" }
  | { status: "capacity" };

export type OrphanedWorkspaceTerminal = WorkspaceTerminalReservation;

export type DevelopmentEnvironmentReservation = Readonly<{
  environmentId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  environmentVersionId: string;
  generation: number;
}>;

export type DevelopmentEnvironmentReservationResult =
  | { status: "reserved" }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "tenant_capacity" }
  | { status: "capacity" };

export type DevelopmentEnvironmentOwnerResult =
  | { status: "owned"; state: DevelopmentEnvironmentState }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "unavailable" };

export type PersistentConversationHandoff = Readonly<{
  tenantId: string;
  workspaceId: string;
  currentSessionId: string;
  nextSessionId: string;
}>;

export interface SandboxActivationStateRepository {
  start(): Promise<void>;
  checkHealth(): Promise<void>;
  assertLocalOwnership(): void;
  reserve(input: SandboxActivationReservation): Promise<SandboxActivationReservationResult>;
  reserveTerminal(input: WorkspaceTerminalReservation): Promise<WorkspaceTerminalReservationResult>;
  reserveDevelopmentEnvironment(
    input: DevelopmentEnvironmentReservation,
  ): Promise<DevelopmentEnvironmentReservationResult>;
  developmentEnvironmentOwner(
    tenantId: string,
    userId: string,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentOwnerResult>;
  setDevelopmentEnvironmentState(
    environmentId: string,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
    detail?: { handle?: SandboxHandle; failureCode?: string },
  ): Promise<void>;
  claimOrphanedDevelopmentEnvironments(
    limit: number,
  ): Promise<readonly DevelopmentEnvironmentReservation[]>;
  setTerminalState(
    terminalId: string,
    state: WorkspaceTerminalState,
    detail?: { handle?: SandboxHandle; failureCode?: string },
  ): Promise<void>;
  claimOrphanedTerminals(limit: number): Promise<readonly OrphanedWorkspaceTerminal[]>;
  allowsDelegatedSandboxHandoff(input: PersistentConversationHandoff): Promise<boolean>;
  allowsPersistentConversationHandoff(input: PersistentConversationHandoff): Promise<boolean>;
  setActivationState(
    activationId: string,
    state: ToolBrokerActivationState,
    detail?: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string },
  ): Promise<void>;
  beginOperation(
    activationId: string,
    operationId: string,
    requestSha256: string,
  ): Promise<"started" | "unknown">;
  settleOperation(
    operationId: string,
    state: Exclude<ToolBrokerOperationState, "running">,
    failureCode?: string,
  ): Promise<void>;
  claimOrphanedActivations(limit: number): Promise<readonly SandboxOrphanedActivation[]>;
  claimTerminalRunActivations(limit: number): Promise<readonly SandboxOrphanedActivation[]>;
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
  readonly #terminals = new Map<string, WorkspaceTerminalReservation>();
  readonly #activations = new Map<string, SandboxActivationReservation>();
  readonly #developmentEnvironments = new Map<
    string,
    { reservation: DevelopmentEnvironmentReservation; state: DevelopmentEnvironmentState }
  >();

  async start(): Promise<void> {}
  async checkHealth(): Promise<void> {}
  assertLocalOwnership(): void {}
  async reserve(input: SandboxActivationReservation): Promise<SandboxActivationReservationResult> {
    if (
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === input.assignment.tenantId &&
          terminal.workspaceId === input.assignment.workspaceId,
      ) ||
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment }) =>
          environment.tenantId === input.assignment.tenantId &&
          environment.workspaceId === input.assignment.workspaceId,
      )
    ) {
      return { status: "busy" };
    }
    this.#activations.set(input.activationId, input);
    return { status: "reserved" };
  }
  async reserveTerminal(
    input: WorkspaceTerminalReservation,
  ): Promise<WorkspaceTerminalReservationResult> {
    if (
      [...this.#activations.values()].some(
        (activation) =>
          activation.assignment.tenantId === input.tenantId &&
          activation.assignment.workspaceId === input.workspaceId,
      ) ||
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === input.tenantId && terminal.workspaceId === input.workspaceId,
      ) ||
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment }) =>
          environment.tenantId === input.tenantId && environment.workspaceId === input.workspaceId,
      )
    ) {
      return { status: "busy" };
    }
    this.#terminals.set(input.terminalId, input);
    return { status: "reserved" };
  }
  async reserveDevelopmentEnvironment(
    input: DevelopmentEnvironmentReservation,
  ): Promise<DevelopmentEnvironmentReservationResult> {
    if (
      [...this.#activations.values()].some(
        (activation) =>
          activation.assignment.tenantId === input.tenantId &&
          activation.assignment.workspaceId === input.workspaceId,
      ) ||
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === input.tenantId && terminal.workspaceId === input.workspaceId,
      ) ||
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment }) =>
          environment.tenantId === input.tenantId &&
          environment.workspaceId === input.workspaceId &&
          environment.environmentId !== input.environmentId,
      )
    ) {
      return { status: "busy" };
    }
    this.#developmentEnvironments.set(input.environmentId, {
      reservation: input,
      state: "running",
    });
    return { status: "reserved" };
  }
  async developmentEnvironmentOwner(
    _tenantId: string,
    _userId: string,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentOwnerResult> {
    const environment = this.#developmentEnvironments.get(environmentId);
    return environment === undefined
      ? { status: "unavailable" }
      : { status: "owned", state: environment.state };
  }
  async setDevelopmentEnvironmentState(
    environmentId: string,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
  ): Promise<void> {
    const environment = this.#developmentEnvironments.get(environmentId);
    if (state === "released" || state === "failed") {
      this.#developmentEnvironments.delete(environmentId);
    } else if (environment !== undefined) {
      environment.state = state;
    }
  }
  async claimOrphanedDevelopmentEnvironments(): Promise<
    readonly DevelopmentEnvironmentReservation[]
  > {
    return [];
  }
  async setTerminalState(terminalId: string, state: WorkspaceTerminalState): Promise<void> {
    if (state === "released") this.#terminals.delete(terminalId);
  }
  async claimOrphanedTerminals(): Promise<readonly OrphanedWorkspaceTerminal[]> {
    return [];
  }
  async allowsPersistentConversationHandoff(): Promise<boolean> {
    return false;
  }
  async allowsDelegatedSandboxHandoff(): Promise<boolean> {
    return false;
  }
  async setActivationState(
    activationId: string,
    state: ToolBrokerActivationState,
    _detail?: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string },
  ): Promise<void> {
    if (state === "released") this.#activations.delete(activationId);
  }
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
  async claimTerminalRunActivations(): Promise<readonly SandboxOrphanedActivation[]> {
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
  sandboxDomainId: string;
  instanceId: string;
  ownerBaseUrl: string;
  leaseMs?: number;
  heartbeatMs?: number;
  clock?: () => Date;
};

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Tool Broker state clock returned an invalid date");
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
  return /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "tool_broker_failed";
}

export class PostgresSandboxActivationStateRepository implements SandboxActivationStateRepository {
  readonly #database: Kysely<Database>;
  readonly #sandboxDomainId: string;
  readonly #instanceId: string;
  readonly #ownerBaseUrl: string;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #clock: () => Date;
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;
  #confirmedLeaseExpiresAt = 0;

  constructor(options: PostgresSandboxActivationStateRepositoryOptions) {
    this.#database = options.database;
    this.#sandboxDomainId = options.sandboxDomainId;
    this.#instanceId = options.instanceId;
    this.#ownerBaseUrl = new URL(options.ownerBaseUrl).toString();
    this.#leaseMs = positiveInteger(options.leaseMs ?? 15_000, "leaseMs");
    this.#heartbeatMs = positiveInteger(options.heartbeatMs ?? 5_000, "heartbeatMs");
    if (this.#heartbeatMs * 2 >= this.#leaseMs) {
      throw new TypeError("Tool Broker heartbeat must leave lease failure margin");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.#heartbeat !== undefined || this.#closed) {
      throw new Error("Tool Broker state repository can only start once");
    }
    const now = validDate(this.#clock);
    const leaseExpiresAt = new Date(now.valueOf() + this.#leaseMs);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#markExpiredOwnersLost(transaction, now);
      await transaction
        .insertInto("tool_broker_instances")
        .values({
          instance_id: this.#instanceId,
          sandbox_domain_id: this.#sandboxDomainId,
          owner_base_url: this.#ownerBaseUrl,
          state: "ready",
          lease_expires_at: leaseExpiresAt,
          last_heartbeat_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
    });
    this.#confirmedLeaseExpiresAt = leaseExpiresAt.valueOf();
    this.#heartbeat = setInterval(
      () => void this.#renew().catch(() => undefined),
      this.#heartbeatMs,
    );
    this.#heartbeat.unref();
  }

  async checkHealth(): Promise<void> {
    const now = validDate(this.#clock);
    const row = await this.#database
      .selectFrom("tool_broker_instances")
      .select("lease_expires_at")
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", now)
      .executeTakeFirst();
    if (row === undefined) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Tool Broker database ownership lease is not current",
      );
    }
    this.#confirmedLeaseExpiresAt = row.lease_expires_at.valueOf();
  }

  assertLocalOwnership(): void {
    const now = validDate(this.#clock);
    if (this.#closed || now.valueOf() >= this.#confirmedLeaseExpiresAt) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Tool Broker locally confirmed ownership lease expired",
      );
    }
  }

  async reserve(input: SandboxActivationReservation): Promise<SandboxActivationReservationResult> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select("sandbox_domain_id")
        .where("workspaces.tenant_id", "=", input.assignment.tenantId)
        .where("workspaces.id", "=", input.assignment.workspaceId)
        .where("workspaces.deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (workspace?.sandbox_domain_id !== this.#sandboxDomainId) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Workspace is not assigned to this Sandbox Domain",
        );
      }
      const liveTerminal = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select("terminal_id")
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("workspace_id", "=", input.assignment.workspaceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirst();
      if (liveTerminal !== undefined) return { status: "busy" };
      const liveDevelopmentEnvironment = await transaction
        .selectFrom("development_environments")
        .select("id")
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("workspace_id", "=", input.assignment.workspaceId)
        .where("state", "in", [
          "requested",
          "provisioning",
          "running",
          "paused",
          "releasing",
          "unknown",
        ])
        .executeTakeFirst();
      if (liveDevelopmentEnvironment !== undefined) return { status: "busy" };
      const existing = await transaction
        .selectFrom("tool_broker_activations")
        .selectAll()
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("workspace_id", "=", input.assignment.workspaceId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.owner_instance_id !== this.#instanceId) {
          return { status: "redirect", ownerBaseUrl: existing.owner_base_url };
        }
        const delegatedHandoff =
          existing.session_id === input.assignment.sessionId
            ? undefined
            : await transaction
                .selectFrom("subagent_executions")
                .select("id")
                .where("tenant_id", "=", input.assignment.tenantId)
                .where("workspace_mode", "=", "shared_serialized")
                .where((expression) =>
                  expression.or([
                    expression.and([
                      expression("parent_session_id", "=", existing.session_id),
                      expression("child_session_id", "=", input.assignment.sessionId),
                    ]),
                    expression.and([
                      expression("parent_session_id", "=", input.assignment.sessionId),
                      expression("child_session_id", "=", existing.session_id),
                    ]),
                  ]),
                )
                .executeTakeFirst();
        const activeOperation = await transaction
          .selectFrom("tool_broker_operations")
          .select("operation_id")
          .where("activation_id", "=", existing.activation_id)
          .where("state", "=", "running")
          .executeTakeFirst();
        const ordinaryWarmReuse =
          existing.state === "warm" &&
          existing.session_id === input.assignment.sessionId &&
          existing.workspace_revision === (input.workspaceRevision ?? null) &&
          existing.environment_sha256 === input.environmentSha256;
        const delegatedReuse =
          delegatedHandoff !== undefined &&
          ["reserved", "materializing", "active", "warm"].includes(existing.state) &&
          activeOperation === undefined &&
          existing.environment_sha256 === input.environmentSha256;
        const reusable = ordinaryWarmReuse || delegatedReuse;
        if (!reusable) return { status: "busy" };
        if (existing.activation_id !== input.activationId) {
          throw new SandboxActivationStateRepositoryError(
            "state_conflict",
            "Delegated activation identity changed inside one owner",
          );
        }
        await transaction
          .updateTable("tool_broker_activations")
          .set({
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
            state: "reserved",
            failure_code: null,
            updated_at: now,
          })
          .where("activation_id", "=", input.activationId)
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "=", existing.state)
          .executeTakeFirstOrThrow();
        return { status: "reserved" };
      }
      const domain = await transaction
        .selectFrom("sandbox_domains")
        .select("maximum_active_sandboxes")
        .where("id", "=", this.#sandboxDomainId)
        .where("state", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (domain === undefined) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Sandbox Domain is not active",
        );
      }
      const tenantPolicy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select("maximum_active_sandboxes")
        .where("tenant_id", "=", input.assignment.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (tenantPolicy === undefined) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Tenant Sandbox policy is unavailable",
        );
      }
      const tenantLive = await transaction
        .selectFrom("tool_broker_activations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirstOrThrow();
      const tenantTerminals = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirstOrThrow();
      const tenantDevelopmentEnvironments = await transaction
        .selectFrom("development_environments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
        .executeTakeFirstOrThrow();
      if (
        Number(tenantLive.count) +
          Number(tenantTerminals.count) +
          Number(tenantDevelopmentEnvironments.count) >=
        tenantPolicy.maximum_active_sandboxes
      ) {
        return { status: "tenant_capacity" };
      }
      const live = await transaction
        .selectFrom("tool_broker_activations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirstOrThrow();
      const terminalLive = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirstOrThrow();
      const domainDevelopmentEnvironments = await transaction
        .selectFrom("development_environments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
        .executeTakeFirstOrThrow();
      if (
        Number(live.count) +
          Number(terminalLive.count) +
          Number(domainDevelopmentEnvironments.count) >=
        domain.maximum_active_sandboxes
      ) {
        return { status: "capacity" };
      }
      await transaction
        .insertInto("tool_broker_activations")
        .values({
          activation_id: input.activationId,
          sandbox_domain_id: this.#sandboxDomainId,
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

  async reserveTerminal(
    input: WorkspaceTerminalReservation,
  ): Promise<WorkspaceTerminalReservationResult> {
    const now = validDate(this.#clock);
    const leaseExpiresAt = new Date(now.valueOf() + this.#leaseMs);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["sandbox_domain_id", "project_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.workspaceId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (
        workspace?.sandbox_domain_id !== this.#sandboxDomainId ||
        workspace.project_id !== input.projectId
      ) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Workspace terminal identity did not match this Sandbox Domain",
        );
      }
      const session = await transaction
        .selectFrom("sessions")
        .select("id")
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.sessionId)
        .where("workspace_id", "=", input.workspaceId)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (session === undefined) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Workspace terminal Session was unavailable",
        );
      }
      const activation = await transaction
        .selectFrom("tool_broker_activations")
        .select([
          "activation_id",
          "owner_instance_id",
          "owner_base_url",
          "state",
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
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirst();
      const developmentEnvironment = await transaction
        .selectFrom("development_environments")
        .select("id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", [
          "requested",
          "provisioning",
          "running",
          "paused",
          "releasing",
          "unknown",
        ])
        .executeTakeFirst();
      if (developmentEnvironment !== undefined) return { status: "busy" };
      if (activation !== undefined && activation.state !== "warm") return { status: "busy" };
      if (
        activation?.owner_instance_id !== undefined &&
        activation.owner_instance_id !== this.#instanceId
      ) {
        return { status: "redirect", ownerBaseUrl: activation.owner_base_url };
      }
      const terminal = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select("terminal_id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirst();
      if (terminal !== undefined) return { status: "busy" };
      const domain = await transaction
        .selectFrom("sandbox_domains")
        .select("maximum_active_sandboxes")
        .where("id", "=", this.#sandboxDomainId)
        .where("state", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select("maximum_active_sandboxes")
        .where("tenant_id", "=", input.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (domain === undefined || policy === undefined) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Workspace terminal capacity policy was unavailable",
        );
      }
      const [
        tenantActivations,
        tenantTerminals,
        tenantDevelopmentEnvironments,
        domainActivations,
        domainTerminals,
        domainDevelopmentEnvironments,
      ] = await Promise.all([
        transaction
          .selectFrom("tool_broker_activations")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("tenant_id", "=", input.tenantId)
          .where("state", "in", [
            "reserved",
            "materializing",
            "active",
            "warm",
            "cleaning",
            "unknown",
          ])
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("workspace_terminal_sessions")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("tenant_id", "=", input.tenantId)
          .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("development_environments")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("tenant_id", "=", input.tenantId)
          .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("tool_broker_activations")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("sandbox_domain_id", "=", this.#sandboxDomainId)
          .where("state", "in", [
            "reserved",
            "materializing",
            "active",
            "warm",
            "cleaning",
            "unknown",
          ])
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("workspace_terminal_sessions")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("sandbox_domain_id", "=", this.#sandboxDomainId)
          .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("development_environments")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("sandbox_domain_id", "=", this.#sandboxDomainId)
          .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
          .executeTakeFirstOrThrow(),
      ]);
      if (
        Number(tenantActivations.count) +
          Number(tenantTerminals.count) -
          (activation === undefined ? 0 : 1) +
          Number(tenantDevelopmentEnvironments.count) >=
        policy.maximum_active_sandboxes
      ) {
        return { status: "tenant_capacity" };
      }
      if (
        Number(domainActivations.count) +
          Number(domainTerminals.count) -
          (activation === undefined ? 0 : 1) +
          Number(domainDevelopmentEnvironments.count) >=
        domain.maximum_active_sandboxes
      ) {
        return { status: "capacity" };
      }
      await transaction
        .insertInto("workspace_terminal_sessions")
        .values({
          terminal_id: input.terminalId,
          sandbox_domain_id: this.#sandboxDomainId,
          owner_instance_id: this.#instanceId,
          owner_base_url: this.#ownerBaseUrl,
          tenant_id: input.tenantId,
          user_id: input.userId,
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          session_id: input.sessionId,
          runtime_id: null,
          runtime_name: null,
          state: "reserved",
          lease_expires_at: leaseExpiresAt,
          last_heartbeat_at: now,
          failure_code: null,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      if (activation === undefined) return { status: "reserved" };
      await transaction
        .updateTable("tool_broker_activations")
        .set({ state: "cleaning", updated_at: now })
        .where("activation_id", "=", activation.activation_id)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "warm")
        .executeTakeFirstOrThrow();
      return {
        status: "reserved",
        retiredActivation: {
          activationId: activation.activation_id,
          assignment: {
            tenantId: activation.tenant_id,
            projectId: activation.project_id,
            workspaceId: activation.workspace_id,
            supervisorId: activation.supervisor_id,
            bootId: activation.boot_id,
            sandboxId: activation.sandbox_id,
            commandId: activation.command_id,
            sessionId: activation.session_id,
            turnId: activation.turn_id,
            attemptId: activation.attempt_id,
            leaseId: activation.lease_id,
            fencingToken: Number(activation.fencing_token),
          },
        },
      };
    });
  }

  async reserveDevelopmentEnvironment(
    input: DevelopmentEnvironmentReservation,
  ): Promise<DevelopmentEnvironmentReservationResult> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const environment = await transaction
        .selectFrom("development_environments")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.environmentId)
        .where("owner_user_id", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (
        environment === undefined ||
        environment.project_id !== input.projectId ||
        environment.workspace_id !== input.workspaceId ||
        environment.sandbox_domain_id !== this.#sandboxDomainId
      ) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Development environment identity did not match this Sandbox Domain",
        );
      }
      if (
        environment.owner_instance_id !== null &&
        environment.owner_instance_id !== this.#instanceId &&
        ["provisioning", "running", "paused", "releasing"].includes(environment.state)
      ) {
        return { status: "redirect", ownerBaseUrl: environment.owner_base_url! };
      }
      if (environment.state !== "requested" && environment.state !== "failed") {
        return { status: "busy" };
      }
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["project_id", "sandbox_domain_id", "deleted_at"])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        workspace === undefined ||
        workspace.deleted_at !== null ||
        workspace.project_id !== input.projectId ||
        workspace.sandbox_domain_id !== this.#sandboxDomainId
      ) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Development environment Workspace is unavailable",
        );
      }
      const activeActivation = await transaction
        .selectFrom("tool_broker_activations")
        .select("activation_id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirst();
      const activeTerminal = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select("terminal_id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirst();
      if (activeActivation !== undefined || activeTerminal !== undefined) {
        return { status: "busy" };
      }
      const domain = await transaction
        .selectFrom("sandbox_domains")
        .select("maximum_active_sandboxes")
        .where("id", "=", this.#sandboxDomainId)
        .where("state", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select("maximum_active_sandboxes")
        .where("tenant_id", "=", input.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (domain === undefined || policy === undefined) {
        throw new SandboxActivationStateRepositoryError(
          "state_conflict",
          "Development environment capacity policy is unavailable",
        );
      }
      const tenantReserved = await this.#tenantReservedSandboxes(transaction, input.tenantId);
      if (tenantReserved >= policy.maximum_active_sandboxes) {
        return { status: "tenant_capacity" };
      }
      const domainReserved = await this.#domainReservedSandboxes(transaction);
      if (domainReserved >= domain.maximum_active_sandboxes) return { status: "capacity" };
      await transaction
        .updateTable("development_environments")
        .set({
          environment_version_id: input.environmentVersionId,
          owner_instance_id: this.#instanceId,
          owner_base_url: this.#ownerBaseUrl,
          generation: input.generation,
          state: "provisioning",
          failure_code: null,
          released_at: null,
          updated_at: now,
        })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.environmentId)
        .where("state", "=", environment.state)
        .executeTakeFirstOrThrow();
      return { status: "reserved" };
    });
  }

  async developmentEnvironmentOwner(
    tenantId: string,
    userId: string,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentOwnerResult> {
    this.assertLocalOwnership();
    const now = validDate(this.#clock);
    const row = await this.#database
      .selectFrom("development_environments")
      .select(["owner_instance_id", "owner_base_url", "state"])
      .where("tenant_id", "=", tenantId)
      .where("owner_user_id", "=", userId)
      .where("id", "=", environmentId)
      .executeTakeFirst();
    if (row === undefined || ["requested", "released", "failed"].includes(row.state)) {
      return { status: "unavailable" };
    }
    if (row.owner_instance_id !== this.#instanceId) {
      const owner =
        row.owner_instance_id === null
          ? undefined
          : await this.#database
              .selectFrom("tool_broker_instances")
              .select("owner_base_url")
              .where("instance_id", "=", row.owner_instance_id)
              .where("state", "=", "ready")
              .where("lease_expires_at", ">", now)
              .executeTakeFirst();
      return owner === undefined
        ? { status: "unavailable" }
        : { status: "redirect", ownerBaseUrl: owner.owner_base_url };
    }
    return { status: "owned", state: row.state };
  }

  async setDevelopmentEnvironmentState(
    environmentId: string,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
    detail: { handle?: SandboxHandle; failureCode?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("development_environments")
        .set({
          state,
          ...(state === "released" ? { owner_instance_id: null, owner_base_url: null } : {}),
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          failure_code: failureCode(detail.failureCode),
          released_at: state === "released" ? now : null,
          updated_at: now,
        })
        .where("id", "=", environmentId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .executeTakeFirst();
    });
    if (updated.numUpdatedRows !== 1n) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Development environment ownership is no longer current",
      );
    }
  }

  async claimOrphanedDevelopmentEnvironments(
    limit: number,
  ): Promise<readonly DevelopmentEnvironmentReservation[]> {
    const boundedLimit = positiveInteger(limit, "development environment orphan limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("development_environments")
        .select([
          "id",
          "tenant_id",
          "owner_user_id",
          "project_id",
          "workspace_id",
          "environment_version_id",
          "generation",
        ])
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "=", "unknown")
        .where("environment_version_id", "is not", null)
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("development_environments")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "releasing",
            runtime_id: null,
            runtime_name: null,
            failure_code: "tool_broker_owner_lost",
            updated_at: now,
          })
          .where("id", "=", row.id)
          .where("state", "=", "unknown")
          .executeTakeFirstOrThrow();
      }
      return rows.map((row) => ({
        environmentId: row.id,
        tenantId: row.tenant_id,
        userId: row.owner_user_id,
        projectId: row.project_id,
        workspaceId: row.workspace_id,
        environmentVersionId: row.environment_version_id!,
        generation: Number(row.generation),
      }));
    });
  }

  async setTerminalState(
    terminalId: string,
    state: WorkspaceTerminalState,
    detail: { handle?: SandboxHandle; failureCode?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("workspace_terminal_sessions")
        .set({
          state,
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
          last_heartbeat_at: now,
          failure_code: failureCode(detail.failureCode),
          updated_at: now,
        })
        .where("terminal_id", "=", terminalId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .executeTakeFirst();
    });
    if (updated.numUpdatedRows !== 1n) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Workspace terminal ownership is no longer current",
      );
    }
  }

  async claimOrphanedTerminals(limit: number): Promise<readonly OrphanedWorkspaceTerminal[]> {
    const boundedLimit = positiveInteger(limit, "terminal orphan cleanup limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select(["terminal_id", "tenant_id", "user_id", "project_id", "workspace_id", "session_id"])
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "=", "unknown")
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("workspace_terminal_sessions")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
            last_heartbeat_at: now,
            updated_at: now,
          })
          .where("terminal_id", "=", row.terminal_id)
          .where("state", "=", "unknown")
          .executeTakeFirstOrThrow();
      }
      return rows.map((row) => ({
        terminalId: row.terminal_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        projectId: row.project_id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
      }));
    });
  }

  async allowsPersistentConversationHandoff(
    input: PersistentConversationHandoff,
  ): Promise<boolean> {
    if (input.currentSessionId === input.nextSessionId) return false;
    if (await this.allowsDelegatedSandboxHandoff(input)) return true;
    const result = await sql<{
      start_session_id: string;
      root_session_id: string;
    }>`
      with recursive lineage as (
        select
          sessions.id as start_session_id,
          sessions.id as session_id,
          sessions.conversation_parent_session_id as parent_session_id,
          array[sessions.id]::uuid[] as path,
          0 as depth
        from sessions
        where sessions.tenant_id = ${input.tenantId}
          and sessions.workspace_id = ${input.workspaceId}
          and sessions.archived_at is null
          and sessions.id in (${input.currentSessionId}, ${input.nextSessionId})

        union all

        select
          lineage.start_session_id,
          parent.id as session_id,
          parent.conversation_parent_session_id as parent_session_id,
          lineage.path || parent.id,
          lineage.depth + 1
        from lineage
        join sessions as parent
          on parent.tenant_id = ${input.tenantId}
         and parent.workspace_id = ${input.workspaceId}
         and parent.id = lineage.parent_session_id
         and parent.archived_at is null
        where lineage.parent_session_id is not null
          and lineage.depth < 100
          and not (parent.id = any(lineage.path))
      )
      select
        start_session_id,
        session_id as root_session_id
      from lineage
      where parent_session_id is null
    `.execute(this.#database);
    if (result.rows.length !== 2) return false;
    const roots = new Map(result.rows.map((row) => [row.start_session_id, row.root_session_id]));
    const currentRoot = roots.get(input.currentSessionId);
    return currentRoot !== undefined && currentRoot === roots.get(input.nextSessionId);
  }

  async allowsDelegatedSandboxHandoff(input: PersistentConversationHandoff): Promise<boolean> {
    if (input.currentSessionId === input.nextSessionId) return false;
    const delegated = await this.#database
      .selectFrom("subagent_executions")
      .select("id")
      .where("tenant_id", "=", input.tenantId)
      .where("workspace_mode", "=", "shared_serialized")
      .where((expression) =>
        expression.or([
          expression.and([
            expression("parent_session_id", "=", input.currentSessionId),
            expression("child_session_id", "=", input.nextSessionId),
          ]),
          expression.and([
            expression("parent_session_id", "=", input.nextSessionId),
            expression("child_session_id", "=", input.currentSessionId),
          ]),
        ]),
      )
      .executeTakeFirst();
    return delegated !== undefined;
  }

  async setActivationState(
    activationId: string,
    state: ToolBrokerActivationState,
    detail: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("tool_broker_activations")
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
        .selectFrom("tool_broker_activations")
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
        .selectFrom("tool_broker_operations")
        .select("operation_id")
        .where("operation_id", "=", operationId)
        .executeTakeFirst();
      if (existing !== undefined) return "unknown";
      await transaction
        .insertInto("tool_broker_operations")
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
    state: Exclude<ToolBrokerOperationState, "running">,
    code?: string,
  ): Promise<void> {
    const now = validDate(this.#clock);
    const settled = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("tool_broker_operations")
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
        .selectFrom("tool_broker_activations")
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
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "=", "unknown")
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("tool_broker_activations")
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

  async claimTerminalRunActivations(limit: number): Promise<readonly SandboxOrphanedActivation[]> {
    const boundedLimit = positiveInteger(limit, "terminal Run activation cleanup limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("tool_broker_activations as activation")
        .innerJoin("run_attempts as attempt", (join) =>
          join
            .onRef("attempt.tenant_id", "=", "activation.tenant_id")
            .onRef("attempt.id", "=", "activation.attempt_id"),
        )
        .innerJoin("runs as run", (join) =>
          join
            .onRef("run.tenant_id", "=", "attempt.tenant_id")
            .onRef("run.id", "=", "attempt.run_id"),
        )
        .select([
          "activation.activation_id",
          "activation.tenant_id",
          "activation.project_id",
          "activation.workspace_id",
          "activation.supervisor_id",
          "activation.boot_id",
          "activation.sandbox_id",
          "activation.command_id",
          "activation.session_id",
          "activation.turn_id",
          "activation.attempt_id",
          "activation.lease_id",
          "activation.fencing_token",
        ])
        .where("activation.sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("activation.state", "in", ["reserved", "materializing", "active"])
        .where((expression) =>
          expression.or([
            expression("run.state", "in", [
              "completed",
              "failed",
              "cancelled",
              "timed_out",
              "superseded",
            ]),
            expression("attempt.state", "in", [
              "completed",
              "failed",
              "cancelled",
              "timed_out",
              "superseded",
            ]),
            sql<boolean>`${sql.ref("run.current_attempt_id")} is distinct from ${sql.ref(
              "activation.attempt_id",
            )}`,
          ]),
        )
        .orderBy("activation.updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate("activation")
        .skipLocked()
        .execute();
      const activationIds = rows.map((row) => row.activation_id);
      if (activationIds.length > 0) {
        await transaction
          .updateTable("tool_broker_activations")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            failure_code: "terminal_run_orphan",
            updated_at: now,
          })
          .where("activation_id", "in", activationIds)
          .execute();
        await transaction
          .updateTable("tool_broker_operations")
          .set({
            state: "failed",
            failure_code: "terminal_run_orphan",
            settled_at: now,
          })
          .where("activation_id", "in", activationIds)
          .where("state", "=", "running")
          .execute();
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
        .selectFrom("tool_broker_activations as activation")
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
      .selectFrom("tool_broker_activations")
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
      .where("sandbox_domain_id", "=", this.#sandboxDomainId)
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
        .updateTable("tool_broker_activations")
        .set({ state: "released", failure_code: null, updated_at: now })
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
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
      await transaction
        .updateTable("workspace_terminal_sessions")
        .set({
          state: "unknown",
          failure_code: "tool_broker_stopped",
          lease_expires_at: now,
          updated_at: now,
        })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning"])
        .execute();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#confirmedLeaseExpiresAt = 0;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("tool_broker_operations")
        .set({ state: "unknown", failure_code: "tool_broker_stopped", settled_at: now })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "running")
        .execute();
      await transaction
        .updateTable("tool_broker_activations")
        .set({ state: "unknown", failure_code: "tool_broker_stopped", updated_at: now })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
        .execute();
      await transaction
        .updateTable("development_environments")
        .set({
          state: "unknown",
          runtime_id: null,
          runtime_name: null,
          failure_code: "tool_broker_stopped",
          updated_at: now,
        })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing"])
        .execute();
      await transaction
        .updateTable("tool_broker_instances")
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
      const owner = await transaction
        .updateTable("tool_broker_instances")
        .set({
          last_heartbeat_at: now,
          lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
          updated_at: now,
        })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .where("lease_expires_at", ">", now)
        .executeTakeFirst();
      if (owner.numUpdatedRows === 1n) {
        await transaction
          .updateTable("workspace_terminal_sessions")
          .set({
            lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
            last_heartbeat_at: now,
            updated_at: now,
          })
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "in", ["reserved", "materializing", "active", "cleaning"])
          .execute();
      }
      return owner;
    });
    if (renewed.numUpdatedRows !== 1n) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Tool Broker ownership heartbeat was fenced",
      );
    }
    this.#confirmedLeaseExpiresAt = now.valueOf() + this.#leaseMs;
  }

  async #assertCurrentOwner(transaction: Transaction<Database>, now: Date): Promise<void> {
    const owner = await transaction
      .selectFrom("tool_broker_instances")
      .select("instance_id")
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", now)
      .executeTakeFirst();
    if (owner === undefined) {
      throw new SandboxActivationStateRepositoryError(
        "ownership_lost",
        "Tool Broker database ownership lease is not current",
      );
    }
  }

  async #tenantReservedSandboxes(
    transaction: Transaction<Database>,
    tenantId: string,
  ): Promise<number> {
    const [activations, terminals, environments] = await Promise.all([
      transaction
        .selectFrom("tool_broker_activations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", tenantId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("workspace_terminal_sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", tenantId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("development_environments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", tenantId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
        .executeTakeFirstOrThrow(),
    ]);
    return Number(activations.count) + Number(terminals.count) + Number(environments.count);
  }

  async #domainReservedSandboxes(transaction: Transaction<Database>): Promise<number> {
    const [activations, terminals, environments] = await Promise.all([
      transaction
        .selectFrom("tool_broker_activations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("workspace_terminal_sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("development_environments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
        .executeTakeFirstOrThrow(),
    ]);
    return Number(activations.count) + Number(terminals.count) + Number(environments.count);
  }

  async #markExpiredOwnersLost(transaction: Transaction<Database>, now: Date): Promise<void> {
    const lostInstances = await transaction
      .updateTable("tool_broker_instances")
      .set({ state: "lost", updated_at: now })
      .where("sandbox_domain_id", "=", this.#sandboxDomainId)
      .where("state", "=", "ready")
      .where("lease_expires_at", "<=", now)
      .returning("instance_id")
      .execute();
    const lostIds = lostInstances.map((instance) => instance.instance_id);
    if (lostIds.length === 0) return;
    await transaction
      .updateTable("tool_broker_operations")
      .set({ state: "unknown", failure_code: "tool_broker_owner_lost", settled_at: now })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "=", "running")
      .execute();
    await transaction
      .updateTable("tool_broker_activations")
      .set({ state: "unknown", failure_code: "tool_broker_owner_lost", updated_at: now })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
      .execute();
    await transaction
      .updateTable("workspace_terminal_sessions")
      .set({
        state: "unknown",
        failure_code: "tool_broker_owner_lost",
        lease_expires_at: now,
        updated_at: now,
      })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["reserved", "materializing", "active", "cleaning"])
      .execute();
    await transaction
      .updateTable("development_environments")
      .set({
        state: "unknown",
        runtime_id: null,
        runtime_name: null,
        failure_code: "tool_broker_owner_lost",
        updated_at: now,
      })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["provisioning", "running", "paused", "releasing"])
      .execute();
  }
}
