import type {
  Database,
  SandboxRetirementReason,
  SupervisorConnectionCloseReason,
} from "@pi-cloud/database";
import { transitionSandbox, type SandboxState } from "@pi-cloud/domain";
import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type SupervisorHeartbeatAckMessage,
  type SupervisorRegisterMessage,
  type SupervisorRegisteredMessage,
} from "@pi-cloud/protocol";
import { PINNED_PI_CODING_AGENT_VERSION } from "@pi-cloud/sandbox-supervisor/pi-turn-runtime";
import { createHash } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { SandboxRetirementResult } from "./assignment-reconciler.ts";
import {
  SessionLeaseCoordinator,
  SessionLeaseCoordinatorError,
  type SupervisorConnectionGuard,
} from "@pi-cloud/runtime-core/session-lease-coordinator";

const DEFAULT_SUPERVISOR_VERSION = "0.1.0";
const DEFAULT_PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const DEFAULT_REQUIRED_CAPABILITIES = ["event.replay", "pi.sdk"] as const;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_RETIREMENT_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETIREMENT_CLAIM_DURATION_MS = 120_000;
const DEFAULT_SWEEP_LIMIT = 100;
const DEFAULT_RETIREMENT_LIMIT = 10;

export type SupervisorTransportAuthority = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
  transportId: string;
};

export type SupervisorBootIdentity = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
};

export interface SupervisorOwnerBoundary {
  /**
   * Resolve only after this exact boot cannot create another execution runtime.
   * A transport close or missed heartbeat alone does not satisfy this contract.
   */
  stopAndConfirm(identity: SupervisorBootIdentity): Promise<void>;
}

export interface SupervisorAssignmentRetirer {
  retireSandbox(): Promise<SandboxRetirementResult>;
}

export type SupervisorConnectionManagerOptions = {
  database: Kysely<Database>;
  controlPlaneInstanceId: string;
  ownerBoundary: SupervisorOwnerBoundary;
  assignmentRetirerFactory: (identity: SupervisorBootIdentity) => SupervisorAssignmentRetirer;
  clock?: () => Date;
  idGenerator?: () => string;
  expectedSupervisorVersion?: string;
  expectedPiPackageName?: string;
  expectedPiVersion?: string;
  requiredCapabilities?: readonly string[];
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  leaseDurationMs?: number;
  retirementRetryDelayMs?: number;
  retirementClaimDurationMs?: number;
};

export type SupervisorConnectionSweepResult = {
  scannedConnections: number;
  expiredConnections: number;
  expiredConnectionIds: readonly string[];
};

export type SupervisorRetirementWorkResult =
  | { kind: "idle" }
  | {
      kind: "retired";
      identity: SupervisorBootIdentity;
      attempt: number;
      reconciliation: SandboxRetirementResult;
    }
  | {
      kind: "retry_scheduled" | "blocked";
      identity: SupervisorBootIdentity;
      attempt: number;
      errorCode: string;
    };

export type SupervisorMaintenanceCycleResult = {
  connections: SupervisorConnectionSweepResult;
  retirements: readonly Exclude<SupervisorRetirementWorkResult, { kind: "idle" }>[];
};

export class SupervisorConnectionManagerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorConnectionManagerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class SupervisorOwnerBoundaryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorOwnerBoundaryError";
    this.code = code;
    this.retryable = retryable;
  }
}

type SandboxIdentityRow = {
  id: string;
  supervisor_id: string;
  boot_id: string;
  state: SandboxState;
  max_concurrent_sessions: number;
};

type ConnectionRow = {
  connection_id: string;
  transport_id: string;
  registration_message_id: string;
  registered_message_id: string;
  sandbox_id: string;
  supervisor_id: string;
  boot_id: string;
  control_plane_instance_id: string;
  state: "active" | "superseded" | "fenced";
  registration_fingerprint: string;
  selected_protocol_version: number;
  heartbeat_interval_ms: number;
  heartbeat_timeout_ms: number;
  registered_at: Date;
  expires_at: Date;
};

type RetirementClaim = {
  identity: SupervisorBootIdentity;
  claimId: string;
  attempt: number;
};

type RegistrationTransactionResult =
  | { kind: "accepted"; connection: ConnectionRow }
  | { kind: "rejected"; code: string; message: string; retryable: boolean };

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("supervisor connection manager clock must return a valid Date");
  }
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function normalizedCapabilities(values: readonly string[]): readonly string[] {
  const result = [...new Set(values)].sort();
  if (result.length !== values.length) {
    throw new TypeError("requiredCapabilities must not contain duplicates");
  }
  return result;
}

function registrationFingerprint(message: SupervisorRegisterMessage): string {
  const normalized = {
    protocolVersion: message.protocolVersion,
    sentAt: message.sentAt,
    payload: {
      ...message.payload,
      supportedProtocolVersions: [...message.payload.supportedProtocolVersions].sort(
        (left, right) => left - right,
      ),
      capabilities: [...message.payload.capabilities].sort(),
    },
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function safeErrorCode(error: unknown): { code: string; retryable: boolean } {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code) &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "supervisor_retirement_failed", retryable: true };
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new SupervisorConnectionManagerError(
      "supervisor_connection_invariant",
      `${description} changed ${updatedRows} rows`,
      false,
    );
  }
}

export class SupervisorConnectionManager {
  readonly #database: Kysely<Database>;
  readonly #controlPlaneInstanceId: string;
  readonly #ownerBoundary: SupervisorOwnerBoundary;
  readonly #assignmentRetirerFactory: (
    identity: SupervisorBootIdentity,
  ) => SupervisorAssignmentRetirer;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #expectedSupervisorVersion: string;
  readonly #expectedPiPackageName: string;
  readonly #expectedPiVersion: string;
  readonly #requiredCapabilities: readonly string[];
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #leaseDurationMs: number;
  readonly #retirementRetryDelayMs: number;
  readonly #retirementClaimDurationMs: number;

  get controlPlaneInstanceId(): string {
    return this.#controlPlaneInstanceId;
  }

  constructor(options: SupervisorConnectionManagerOptions) {
    this.#database = options.database;
    this.#controlPlaneInstanceId = requireUuid(
      options.controlPlaneInstanceId,
      "controlPlaneInstanceId",
    );
    this.#ownerBoundary = options.ownerBoundary;
    this.#assignmentRetirerFactory = options.assignmentRetirerFactory;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#expectedSupervisorVersion = nonEmpty(
      options.expectedSupervisorVersion ?? DEFAULT_SUPERVISOR_VERSION,
      "expectedSupervisorVersion",
    );
    this.#expectedPiPackageName = nonEmpty(
      options.expectedPiPackageName ?? DEFAULT_PI_PACKAGE_NAME,
      "expectedPiPackageName",
    );
    this.#expectedPiVersion = nonEmpty(
      options.expectedPiVersion ?? PINNED_PI_CODING_AGENT_VERSION,
      "expectedPiVersion",
    );
    this.#requiredCapabilities = normalizedCapabilities(
      options.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES,
    );
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.#heartbeatTimeoutMs = positiveInteger(
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      "heartbeatTimeoutMs",
    );
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.#retirementRetryDelayMs = positiveInteger(
      options.retirementRetryDelayMs ?? DEFAULT_RETIREMENT_RETRY_DELAY_MS,
      "retirementRetryDelayMs",
    );
    this.#retirementClaimDurationMs = positiveInteger(
      options.retirementClaimDurationMs ?? DEFAULT_RETIREMENT_CLAIM_DURATION_MS,
      "retirementClaimDurationMs",
    );
    if (this.#heartbeatTimeoutMs <= this.#heartbeatIntervalMs) {
      throw new TypeError("heartbeatTimeoutMs must be greater than heartbeatIntervalMs");
    }
    if (this.#leaseDurationMs < this.#heartbeatTimeoutMs) {
      throw new TypeError("leaseDurationMs must be at least heartbeatTimeoutMs");
    }
  }

  async register(
    value: unknown,
    authority: SupervisorTransportAuthority,
  ): Promise<SupervisorRegisteredMessage> {
    const message = this.#parseRegistration(value);
    this.#validateAuthority(authority, message.payload);
    const fingerprint = registrationFingerprint(message);
    const now = validDate(this.#clock);
    const result = await this.#database
      .transaction()
      .execute(async (transaction): Promise<RegistrationTransactionResult> => {
        const sandboxes = await transaction
          .selectFrom("sandboxes")
          .select(["id", "supervisor_id", "boot_id", "state", "max_concurrent_sessions"])
          .where("supervisor_id", "=", authority.supervisorId)
          .orderBy("id", "asc")
          .forUpdate()
          .execute();
        const current = sandboxes.find((sandbox) => sandbox.id === authority.sandboxId);
        if (
          current === undefined ||
          current.supervisor_id !== authority.supervisorId ||
          current.boot_id !== authority.bootId
        ) {
          return this.#registrationRejection(
            "unauthorized_sandbox",
            "Supervisor registration does not match a provisioned sandbox",
            false,
          );
        }
        if (
          sandboxes.some(
            (sandbox) => sandbox.id !== current.id && sandbox.boot_id === authority.bootId,
          )
        ) {
          return this.#registrationRejection(
            "boot_identity_collision",
            "Supervisor boot is already bound to another sandbox",
            false,
          );
        }
        if (message.payload.maxConcurrentSessions !== current.max_concurrent_sessions) {
          return this.#registrationRejection(
            "capacity_mismatch",
            "Supervisor capacity does not match its provisioned sandbox",
            false,
          );
        }

        const sandboxIds = sandboxes.map((sandbox) => sandbox.id);
        const connections =
          sandboxIds.length === 0
            ? []
            : await transaction
                .selectFrom("supervisor_connections")
                .select([
                  "connection_id",
                  "transport_id",
                  "registration_message_id",
                  "registered_message_id",
                  "sandbox_id",
                  "supervisor_id",
                  "boot_id",
                  "control_plane_instance_id",
                  "state",
                  "registration_fingerprint",
                  "selected_protocol_version",
                  "heartbeat_interval_ms",
                  "heartbeat_timeout_ms",
                  "registered_at",
                  "expires_at",
                ])
                .where("sandbox_id", "in", sandboxIds)
                .orderBy("connection_id", "asc")
                .forUpdate()
                .execute();
        const transportConnection = connections.find(
          (connection) => connection.transport_id === authority.transportId,
        );
        if (transportConnection !== undefined) {
          if (
            transportConnection.registration_message_id !== message.messageId ||
            transportConnection.registration_fingerprint !== fingerprint ||
            transportConnection.supervisor_id !== authority.supervisorId ||
            transportConnection.boot_id !== authority.bootId ||
            transportConnection.sandbox_id !== authority.sandboxId ||
            transportConnection.control_plane_instance_id !== this.#controlPlaneInstanceId
          ) {
            return this.#registrationRejection(
              "registration_conflict",
              "Transport registration identity changed",
              false,
            );
          }
          if (
            transportConnection.state === "active" &&
            new Date(transportConnection.expires_at).valueOf() > now.valueOf()
          ) {
            return { kind: "accepted", connection: transportConnection };
          }
          if (transportConnection.state === "active") {
            await this.#fenceSandbox(transaction, current, "heartbeat_timeout", now);
          }
          return this.#registrationRejection(
            "stale_registration",
            "Supervisor registration is no longer current",
            false,
          );
        }

        const registrationReplay = await transaction
          .selectFrom("supervisor_connections")
          .select(["transport_id"])
          .where("registration_message_id", "=", message.messageId)
          .forUpdate()
          .executeTakeFirst();
        if (registrationReplay !== undefined) {
          return this.#registrationRejection(
            "registration_replay",
            "Registration message was already used by another transport",
            false,
          );
        }

        const currentConnections = connections.filter(
          (connection) => connection.sandbox_id === current.id,
        );
        const currentActive = currentConnections.find(
          (connection) => connection.state === "active",
        );
        if (
          current.state === "failed" ||
          current.state === "draining" ||
          current.state === "terminated"
        ) {
          return this.#registrationRejection(
            "sandbox_unavailable",
            "Supervisor sandbox cannot be registered",
            false,
          );
        }
        if (current.state === "provisioning" && currentConnections.length !== 0) {
          return this.#registrationRejection(
            "registration_invariant",
            "Provisioning sandbox already has connection history",
            false,
          );
        }
        if (
          (current.state === "ready" || current.state === "leased") &&
          currentActive === undefined &&
          currentConnections.length !== 0
        ) {
          return this.#registrationRejection(
            "stale_registration",
            "Supervisor sandbox has no current connection",
            false,
          );
        }
        if (
          currentActive !== undefined &&
          new Date(currentActive.expires_at).valueOf() <= now.valueOf()
        ) {
          const freshExecution = await this.#hasFreshExecution(transaction, current.id, now);
          if (!freshExecution) {
            await this.#fenceSandbox(transaction, current, "heartbeat_timeout", now);
            return this.#registrationRejection(
              "stale_registration",
              "Expired supervisor connection cannot be revived",
              false,
            );
          }
        }

        this.#validateRegistrationPolicy(message);
        for (const oldSandbox of sandboxes) {
          if (oldSandbox.id === current.id || oldSandbox.state === "terminated") continue;
          await this.#fenceSandbox(transaction, oldSandbox, "new_boot", now);
        }
        if (currentActive !== undefined) {
          const superseded = await transaction
            .updateTable("supervisor_connections")
            .set({ state: "superseded", close_reason: "reconnected", closed_at: now })
            .where("connection_id", "=", currentActive.connection_id)
            .where("state", "=", "active")
            .executeTakeFirst();
          expectOne(superseded.numUpdatedRows, "superseding a supervisor connection");
        }
        if (current.state === "provisioning") {
          await transaction
            .updateTable("sandboxes")
            .set({ state: transitionSandbox(current.state, "ready"), updated_at: now })
            .where("id", "=", current.id)
            .where("state", "=", current.state)
            .executeTakeFirstOrThrow();
        }

        const connectionId = requireUuid(this.#idGenerator(), "generated connectionId");
        const registeredMessageId = requireUuid(
          this.#idGenerator(),
          "generated registered messageId",
        );
        const expiresAt = new Date(now.valueOf() + this.#heartbeatTimeoutMs);
        await transaction
          .insertInto("supervisor_connections")
          .values({
            connection_id: connectionId,
            transport_id: authority.transportId,
            registration_message_id: message.messageId,
            registered_message_id: registeredMessageId,
            sandbox_id: authority.sandboxId,
            supervisor_id: authority.supervisorId,
            boot_id: authority.bootId,
            control_plane_instance_id: this.#controlPlaneInstanceId,
            state: "active",
            close_reason: null,
            registration_fingerprint: fingerprint,
            supervisor_version: message.payload.supervisorVersion,
            pi_package_name: message.payload.pi.packageName,
            pi_version: message.payload.pi.version,
            supported_protocol_versions: [...message.payload.supportedProtocolVersions],
            capabilities: [...message.payload.capabilities],
            selected_protocol_version: 1,
            heartbeat_interval_ms: this.#heartbeatIntervalMs,
            heartbeat_timeout_ms: this.#heartbeatTimeoutMs,
            accepting_assignments: message.payload.acceptingAssignments,
            registered_at: now,
            last_heartbeat_at: now,
            expires_at: expiresAt,
            closed_at: null,
          })
          .executeTakeFirstOrThrow();
        return {
          kind: "accepted",
          connection: {
            connection_id: connectionId,
            transport_id: authority.transportId,
            registration_message_id: message.messageId,
            registered_message_id: registeredMessageId,
            sandbox_id: authority.sandboxId,
            supervisor_id: authority.supervisorId,
            boot_id: authority.bootId,
            control_plane_instance_id: this.#controlPlaneInstanceId,
            state: "active",
            registration_fingerprint: fingerprint,
            selected_protocol_version: 1,
            heartbeat_interval_ms: this.#heartbeatIntervalMs,
            heartbeat_timeout_ms: this.#heartbeatTimeoutMs,
            registered_at: now,
            expires_at: expiresAt,
          },
        };
      });
    if (result.kind === "rejected") {
      throw new SupervisorConnectionManagerError(result.code, result.message, result.retryable);
    }
    return this.#registrationAcknowledgement(result.connection);
  }

  async heartbeat(
    value: unknown,
    authority: SupervisorTransportAuthority,
  ): Promise<SupervisorHeartbeatAckMessage> {
    const parsed = parseSupervisorToControlMessage(value);
    if (parsed.type !== "supervisor.heartbeat") {
      throw new SupervisorConnectionManagerError(
        "invalid_heartbeat",
        "Expected a supervisor heartbeat",
        false,
      );
    }
    this.#validateAuthority(authority, parsed.payload);
    if (parsed.payload.sessions.length === 0) {
      const now = validDate(this.#clock);
      const expiresAt = new Date(now.valueOf() + this.#heartbeatTimeoutMs);
      const updated = await this.#database
        .updateTable("supervisor_connections")
        .set({
          accepting_assignments: parsed.payload.acceptingAssignments,
          last_heartbeat_at: now,
          expires_at: expiresAt,
        })
        .where("connection_id", "=", parsed.payload.connectionId)
        .where("sandbox_id", "=", authority.sandboxId)
        .where("supervisor_id", "=", authority.supervisorId)
        .where("boot_id", "=", authority.bootId)
        .where("transport_id", "=", authority.transportId)
        .where("control_plane_instance_id", "=", this.#controlPlaneInstanceId)
        .where("state", "=", "active")
        .where("expires_at", ">", now)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new SupervisorConnectionManagerError(
          "stale_connection",
          "Supervisor connection authority is stale",
          false,
        );
      }
      const acknowledgement = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: now.toISOString(),
        type: "supervisor.heartbeat.ack",
        payload: {
          acknowledgedMessageId: parsed.messageId,
          connectionId: parsed.payload.connectionId,
          leaseRenewals: [],
        },
      });
      if (acknowledgement.type !== "supervisor.heartbeat.ack") {
        throw new SupervisorConnectionManagerError(
          "heartbeat_ack_invariant",
          "Supervisor heartbeat acknowledgement was invalid",
          false,
        );
      }
      return acknowledgement;
    }
    const coordinator = await this.leaseCoordinator(parsed.payload.connectionId, authority);
    try {
      return await coordinator.renewFromHeartbeat(parsed);
    } catch (error: unknown) {
      if (error instanceof SessionLeaseCoordinatorError) {
        throw new SupervisorConnectionManagerError(
          error.code,
          "Supervisor heartbeat was rejected",
          error.retryable,
        );
      }
      throw error;
    }
  }

  async assertCurrentConnection(
    connectionId: string,
    authority: SupervisorTransportAuthority,
  ): Promise<void> {
    await this.#currentConnection(connectionId, authority);
  }

  async leaseCoordinator(
    connectionId: string,
    authority: SupervisorTransportAuthority,
  ): Promise<SessionLeaseCoordinator> {
    const connection = await this.#currentConnection(connectionId, authority);
    const guard: SupervisorConnectionGuard = {
      controlPlaneInstanceId: this.#controlPlaneInstanceId,
      transportId: authority.transportId,
      heartbeatTimeoutMs: connection.heartbeat_timeout_ms,
    };
    return new SessionLeaseCoordinator({
      database: this.#database,
      sandboxId: authority.sandboxId,
      clock: this.#clock,
      idGenerator: this.#idGenerator,
      leaseDurationMs: this.#leaseDurationMs,
      heartbeatConnectionId: connectionId,
      connectionGuard: guard,
    });
  }

  async #currentConnection(
    connectionId: string,
    authority: SupervisorTransportAuthority,
  ): Promise<{ heartbeat_timeout_ms: number }> {
    requireUuid(connectionId, "connectionId");
    this.#validateAuthorityShape(authority);
    const connection = await this.#database
      .selectFrom("supervisor_connections")
      .select([
        "sandbox_id",
        "supervisor_id",
        "boot_id",
        "transport_id",
        "control_plane_instance_id",
        "heartbeat_timeout_ms",
        "state",
        "expires_at",
      ])
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();
    if (
      connection === undefined ||
      connection.sandbox_id !== authority.sandboxId ||
      connection.supervisor_id !== authority.supervisorId ||
      connection.boot_id !== authority.bootId ||
      connection.transport_id !== authority.transportId ||
      connection.control_plane_instance_id !== this.#controlPlaneInstanceId ||
      connection.state !== "active" ||
      new Date(connection.expires_at).valueOf() <= validDate(this.#clock).valueOf()
    ) {
      throw new SupervisorConnectionManagerError(
        "stale_connection",
        "Supervisor connection authority is stale",
        false,
      );
    }
    return connection;
  }

  async expireConnections(limit = DEFAULT_SWEEP_LIMIT): Promise<SupervisorConnectionSweepResult> {
    const boundedLimit = positiveInteger(limit, "limit");
    const now = validDate(this.#clock);
    const candidates = await this.#database
      .selectFrom("supervisor_connections")
      .select(["connection_id"])
      .where("state", "=", "active")
      .where("expires_at", "<=", now)
      .orderBy("expires_at", "asc")
      .orderBy("connection_id", "asc")
      .limit(boundedLimit)
      .execute();
    const expiredConnectionIds: string[] = [];
    for (const candidate of candidates) {
      const expired = await this.#expireConnection(candidate.connection_id, now);
      if (expired) expiredConnectionIds.push(candidate.connection_id);
    }
    return {
      scannedConnections: candidates.length,
      expiredConnections: expiredConnectionIds.length,
      expiredConnectionIds,
    };
  }

  async processNextRetirement(): Promise<SupervisorRetirementWorkResult> {
    const claim = await this.#claimRetirement(validDate(this.#clock));
    if (claim === undefined) return { kind: "idle" };
    try {
      await this.#ownerBoundary.stopAndConfirm(claim.identity);
      await this.#renewRetirementClaim(claim, validDate(this.#clock));
      const reconciliation = await this.#assignmentRetirerFactory(claim.identity).retireSandbox();
      await this.#completeRetirementClaim(claim, validDate(this.#clock));
      return {
        kind: "retired",
        identity: claim.identity,
        attempt: claim.attempt,
        reconciliation,
      };
    } catch (error: unknown) {
      const normalized = safeErrorCode(error);
      const state = normalized.retryable ? "pending" : "blocked";
      await this.#failRetirementClaim(claim, normalized.code, state, validDate(this.#clock));
      return {
        kind: normalized.retryable ? "retry_scheduled" : "blocked",
        identity: claim.identity,
        attempt: claim.attempt,
        errorCode: normalized.code,
      };
    }
  }

  async runMaintenanceCycle(
    options: {
      connectionLimit?: number;
      retirementLimit?: number;
    } = {},
  ): Promise<SupervisorMaintenanceCycleResult> {
    const retirementLimit = positiveInteger(
      options.retirementLimit ?? DEFAULT_RETIREMENT_LIMIT,
      "retirementLimit",
    );
    const connections = await this.expireConnections(
      options.connectionLimit ?? DEFAULT_SWEEP_LIMIT,
    );
    const retirements: Exclude<SupervisorRetirementWorkResult, { kind: "idle" }>[] = [];
    for (let index = 0; index < retirementLimit; index += 1) {
      const result = await this.processNextRetirement();
      if (result.kind === "idle") break;
      retirements.push(result);
    }
    return { connections, retirements };
  }

  #parseRegistration(value: unknown): SupervisorRegisterMessage {
    let parsed;
    try {
      parsed = parseSupervisorToControlMessage(value);
    } catch {
      throw new SupervisorConnectionManagerError(
        "invalid_registration",
        "Supervisor registration message is invalid",
        false,
      );
    }
    if (parsed.type !== "supervisor.register") {
      throw new SupervisorConnectionManagerError(
        "invalid_registration",
        "Expected a supervisor registration",
        false,
      );
    }
    return parsed;
  }

  #validateRegistrationPolicy(message: SupervisorRegisterMessage): void {
    if (message.payload.supervisorVersion !== this.#expectedSupervisorVersion) {
      throw new SupervisorConnectionManagerError(
        "unsupported_supervisor_version",
        "Supervisor version is not accepted",
        false,
      );
    }
    if (
      message.payload.pi.packageName !== this.#expectedPiPackageName ||
      message.payload.pi.version !== this.#expectedPiVersion
    ) {
      throw new SupervisorConnectionManagerError(
        "unsupported_pi_runtime",
        "Pi runtime is not accepted",
        false,
      );
    }
    if (!message.payload.supportedProtocolVersions.includes(1)) {
      throw new SupervisorConnectionManagerError(
        "unsupported_protocol",
        "Supervisor does not support protocol version 1",
        false,
      );
    }
    const capabilities = new Set(message.payload.capabilities);
    if (this.#requiredCapabilities.some((capability) => !capabilities.has(capability))) {
      throw new SupervisorConnectionManagerError(
        "missing_capability",
        "Supervisor is missing a required capability",
        false,
      );
    }
  }

  #validateAuthority(
    authority: SupervisorTransportAuthority,
    payload: { supervisorId: string; bootId: string; sandboxId?: string },
  ): void {
    this.#validateAuthorityShape(authority);
    if (
      authority.supervisorId !== payload.supervisorId ||
      authority.bootId !== payload.bootId ||
      (payload.sandboxId !== undefined && authority.sandboxId !== payload.sandboxId)
    ) {
      throw new SupervisorConnectionManagerError(
        "unauthorized_supervisor",
        "Supervisor message does not match its authenticated transport",
        false,
      );
    }
  }

  #validateAuthorityShape(authority: SupervisorTransportAuthority): void {
    nonEmpty(authority.supervisorId, "authority.supervisorId");
    requireUuid(authority.bootId, "authority.bootId");
    requireUuid(authority.sandboxId, "authority.sandboxId");
    requireUuid(authority.transportId, "authority.transportId");
  }

  #registrationAcknowledgement(connection: ConnectionRow): SupervisorRegisteredMessage {
    const parsed = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: connection.registered_message_id,
      sentAt: new Date(connection.registered_at).toISOString(),
      type: "supervisor.registered",
      payload: {
        supervisorId: connection.supervisor_id,
        bootId: connection.boot_id,
        connectionId: connection.connection_id,
        selectedProtocolVersion: 1,
        heartbeatIntervalMs: connection.heartbeat_interval_ms,
        heartbeatTimeoutMs: connection.heartbeat_timeout_ms,
        serverTime: new Date(connection.registered_at).toISOString(),
      },
    });
    if (parsed.type !== "supervisor.registered") {
      throw new SupervisorConnectionManagerError(
        "registration_invariant",
        "Stored supervisor registration response is invalid",
        false,
      );
    }
    return parsed;
  }

  #registrationRejection(
    code: string,
    message: string,
    retryable: boolean,
  ): RegistrationTransactionResult {
    return { kind: "rejected", code, message, retryable };
  }

  async #fenceSandbox(
    transaction: Transaction<Database>,
    sandbox: SandboxIdentityRow,
    reason: SandboxRetirementReason,
    now: Date,
  ): Promise<void> {
    const closeReason: SupervisorConnectionCloseReason = reason;
    await transaction
      .updateTable("supervisor_connections")
      .set({ state: "fenced", close_reason: closeReason, closed_at: now })
      .where("sandbox_id", "=", sandbox.id)
      .where("state", "=", "active")
      .execute();
    if (sandbox.state === "terminated") return;
    if (sandbox.state !== "failed") {
      await transaction
        .updateTable("sandboxes")
        .set({ state: transitionSandbox(sandbox.state, "failed"), updated_at: now })
        .where("id", "=", sandbox.id)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    }
    await transaction
      .insertInto("sandbox_retirements")
      .values({
        sandbox_id: sandbox.id,
        supervisor_id: sandbox.supervisor_id,
        boot_id: sandbox.boot_id,
        reason,
        state: "pending",
        attempts: 0,
        available_at: now,
        claim_id: null,
        claim_owner_id: null,
        claim_until: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflict((conflict) => conflict.column("sandbox_id").doNothing())
      .executeTakeFirst();
  }

  async #expireConnection(connectionId: string, now: Date): Promise<boolean> {
    const candidate = await this.#database
      .selectFrom("supervisor_connections")
      .select(["sandbox_id"])
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();
    if (candidate === undefined) return false;
    return this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["id", "supervisor_id", "boot_id", "state", "max_concurrent_sessions"])
        .where("id", "=", candidate.sandbox_id)
        .forUpdate()
        .executeTakeFirst();
      if (sandbox === undefined) {
        throw new SupervisorConnectionManagerError(
          "supervisor_connection_invariant",
          "Supervisor connection references a missing sandbox",
          false,
        );
      }
      const connection = await transaction
        .selectFrom("supervisor_connections")
        .select(["state", "expires_at"])
        .where("connection_id", "=", connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        connection === undefined ||
        connection.state !== "active" ||
        new Date(connection.expires_at).valueOf() > now.valueOf()
      ) {
        return false;
      }
      if (await this.#hasFreshExecution(transaction, sandbox.id, now)) {
        const deferred = await transaction
          .updateTable("supervisor_connections")
          .set({ expires_at: new Date(now.valueOf() + this.#heartbeatTimeoutMs) })
          .where("connection_id", "=", connectionId)
          .where("state", "=", "active")
          .where("expires_at", "<=", now)
          .executeTakeFirst();
        expectOne(deferred.numUpdatedRows, "deferring a live Supervisor connection retirement");
        return false;
      }
      await this.#fenceSandbox(transaction, sandbox, "heartbeat_timeout", now);
      return true;
    });
  }

  async #hasFreshExecution(
    database: Kysely<Database> | Transaction<Database>,
    sandboxId: string,
    now: Date,
  ): Promise<boolean> {
    const freshnessBoundary = new Date(now.valueOf() - this.#heartbeatTimeoutMs);
    const attempt = await database
      .selectFrom("run_attempts")
      .select("id")
      .where("sandbox_id", "=", sandboxId)
      .where("state", "in", [
        "provisioning",
        "restoring",
        "running",
        "checkpointing",
        "cancel_requested",
      ])
      .where("claim_expires_at", ">", now)
      .where("last_heartbeat_at", ">", freshnessBoundary)
      .executeTakeFirst();
    return attempt !== undefined;
  }

  async #claimRetirement(now: Date): Promise<RetirementClaim | undefined> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("sandbox_retirements")
        .select(["sandbox_id", "supervisor_id", "boot_id", "attempts"])
        .where((expression) =>
          expression.or([
            expression.and([
              expression("state", "=", "pending"),
              expression("available_at", "<=", now),
            ]),
            expression.and([
              expression("state", "=", "claimed"),
              expression("claim_until", "<=", now),
            ]),
          ]),
        )
        .orderBy("created_at", "asc")
        .orderBy("sandbox_id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const claimId = requireUuid(this.#idGenerator(), "generated retirement claimId");
      const attempt = row.attempts + 1;
      const updated = await transaction
        .updateTable("sandbox_retirements")
        .set({
          state: "claimed",
          attempts: attempt,
          claim_id: claimId,
          claim_owner_id: this.#controlPlaneInstanceId,
          claim_until: new Date(now.valueOf() + this.#retirementClaimDurationMs),
          updated_at: now,
        })
        .where("sandbox_id", "=", row.sandbox_id)
        .executeTakeFirst();
      expectOne(updated.numUpdatedRows, "claiming sandbox retirement");
      return {
        identity: {
          supervisorId: row.supervisor_id,
          bootId: row.boot_id,
          sandboxId: row.sandbox_id,
        },
        claimId,
        attempt,
      };
    });
  }

  async #renewRetirementClaim(claim: RetirementClaim, now: Date): Promise<void> {
    const updated = await this.#database
      .updateTable("sandbox_retirements")
      .set({
        claim_until: new Date(now.valueOf() + this.#retirementClaimDurationMs),
        updated_at: now,
      })
      .where("sandbox_id", "=", claim.identity.sandboxId)
      .where("state", "=", "claimed")
      .where("claim_id", "=", claim.claimId)
      .where("claim_owner_id", "=", this.#controlPlaneInstanceId)
      .where("claim_until", ">", now)
      .executeTakeFirst();
    expectOne(updated.numUpdatedRows, "renewing sandbox retirement claim");
  }

  async #completeRetirementClaim(claim: RetirementClaim, now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["supervisor_id", "boot_id", "state"])
        .where("id", "=", claim.identity.sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (
        sandbox === undefined ||
        sandbox.supervisor_id !== claim.identity.supervisorId ||
        sandbox.boot_id !== claim.identity.bootId ||
        sandbox.state !== "terminated"
      ) {
        throw new SupervisorConnectionManagerError(
          "retirement_not_confirmed",
          "Sandbox retirement did not reach its durable terminal state",
          false,
        );
      }
      const updated = await transaction
        .updateTable("sandbox_retirements")
        .set({
          state: "completed",
          claim_id: null,
          claim_owner_id: null,
          claim_until: null,
          last_error: null,
          updated_at: now,
          completed_at: now,
        })
        .where("sandbox_id", "=", claim.identity.sandboxId)
        .where("state", "=", "claimed")
        .where("claim_id", "=", claim.claimId)
        .where("claim_owner_id", "=", this.#controlPlaneInstanceId)
        .executeTakeFirst();
      expectOne(updated.numUpdatedRows, "completing sandbox retirement claim");
    });
  }

  async #failRetirementClaim(
    claim: RetirementClaim,
    errorCode: string,
    state: "pending" | "blocked",
    now: Date,
  ): Promise<void> {
    const updated = await this.#database
      .updateTable("sandbox_retirements")
      .set({
        state,
        available_at:
          state === "pending" ? new Date(now.valueOf() + this.#retirementRetryDelayMs) : now,
        claim_id: null,
        claim_owner_id: null,
        claim_until: null,
        last_error: errorCode,
        updated_at: now,
      })
      .where("sandbox_id", "=", claim.identity.sandboxId)
      .where("state", "=", "claimed")
      .where("claim_id", "=", claim.claimId)
      .where("claim_owner_id", "=", this.#controlPlaneInstanceId)
      .executeTakeFirst();
    expectOne(updated.numUpdatedRows, "releasing sandbox retirement claim");
  }
}
