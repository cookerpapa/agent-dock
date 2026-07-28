import { createHash, randomUUID } from "node:crypto";
import type {
  Database,
  OrchestrationAcceptanceVerdict,
  OrchestrationDispatchState,
  OrchestrationState,
} from "@agent-dock/database";
import {
  DomainModelValidationError,
  resolveTurnModel,
  type ModelProfile,
} from "@agent-dock/domain";
import {
  TURN_COMMAND_OUTBOX_TOPIC,
  canonicalWorkspaceSourceSetJson,
  parseCandidateRaceAcceptancePolicy,
  parseCandidateRaceResource,
  parseReviewBundleManifest,
  parseWorkspaceSourceSetSnapshot,
  type CandidateRaceAcceptancePolicy,
  type CandidateRaceListResource,
  type CandidateRaceResource,
  type CreateCandidateRaceRequest,
  type PromoteCandidateRequest,
  type RunState,
  type TurnThinkingLevel,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store.ts";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { classifyStructuredTestCommand } from "./structured-test-command.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

const TERMINAL_RUN_STATES = new Set<RunState>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
  "superseded",
]);
const ACTIVE_RUN_STATES = new Set<RunState>([
  "claimed",
  "provisioning",
  "restoring",
  "running",
  "checkpointing",
  "cancel_requested",
]);
const MAX_LISTED_RACES = 50;

export type CandidateRaceServiceOptions = {
  database: Kysely<Database>;
  controlPlaneStores: ControlPlaneStoreFactory;
  idGenerator?: () => string;
  clock?: () => Date;
};

export type CandidateRaceErrorCode =
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "tenant_quota_exceeded"
  | "control_plane_misconfigured";

export class CandidateRaceError extends Error {
  readonly code: CandidateRaceErrorCode;

  constructor(code: CandidateRaceErrorCode, message: string) {
    super(message);
    this.name = "CandidateRaceError";
    this.code = code;
  }
}

type NormalizedCandidate = {
  label: string;
  strategy: string;
};

type NormalizedCandidateRaceRequest = {
  baseWorkspaceVersionId: string;
  prompt: string;
  candidates: NormalizedCandidate[];
  maximumConcurrentCandidates: number;
  thinkingLevel?: TurnThinkingLevel;
  acceptance: CandidateRaceAcceptancePolicy;
};

function safeDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("CandidateRaceService clock returned an invalid Date");
  }
  return value;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new CandidateRaceError(
      "control_plane_misconfigured",
      "Stored orchestration timestamp is invalid",
    );
  }
  return date.toISOString();
}

function nonNegativeInteger(value: unknown, description: string): number {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new CandidateRaceError("control_plane_misconfigured", `${description} is not numeric`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CandidateRaceError(
      "control_plane_misconfigured",
      `${description} is not a non-negative safe integer`,
    );
  }
  return parsed;
}

function positiveInteger(value: unknown, description: string): number {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new CandidateRaceError("control_plane_misconfigured", `${description} is not numeric`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CandidateRaceError(
      "control_plane_misconfigured",
      `${description} is not a positive safe integer`,
    );
  }
  return parsed;
}

function isUniqueConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  return trimmed.length === 0 ? "." : trimmed;
}

function normalizeRequest(request: CreateCandidateRaceRequest): NormalizedCandidateRaceRequest {
  const protectedPathPrefixes = [
    ...new Set((request.acceptance?.protectedPathPrefixes ?? []).map(normalizePrefix)),
  ].sort((left, right) => left.localeCompare(right));
  const normalized: NormalizedCandidateRaceRequest = {
    baseWorkspaceVersionId: request.baseWorkspaceVersionId,
    prompt: request.prompt.trim(),
    candidates: request.candidates.map((candidate) => ({
      label: candidate.label.trim(),
      strategy: candidate.strategy.trim(),
    })),
    maximumConcurrentCandidates: request.maximumConcurrentCandidates,
    ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
    acceptance: parseCandidateRaceAcceptancePolicy({
      requirePatch: request.acceptance?.requirePatch ?? true,
      requireTests: request.acceptance?.requireTests ?? true,
      maximumChangedPaths: request.acceptance?.maximumChangedPaths ?? 100,
      protectedPathPrefixes,
    }),
  };
  if (Buffer.byteLength(normalized.prompt, "utf8") > 60_000) {
    throw new CandidateRaceError(
      "conflict",
      "Candidate-race prompt is too large after UTF-8 encoding",
    );
  }
  for (const candidate of normalized.candidates) {
    if (Buffer.byteLength(candidate.strategy, "utf8") > 4_096) {
      throw new CandidateRaceError("conflict", "Candidate strategy exceeds 4096 UTF-8 bytes");
    }
  }
  return normalized;
}

function requestFingerprint(request: NormalizedCandidateRaceRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        baseWorkspaceVersionId: request.baseWorkspaceVersionId,
        prompt: request.prompt,
        candidates: request.candidates,
        maximumConcurrentCandidates: request.maximumConcurrentCandidates,
        thinkingLevel: request.thinkingLevel ?? null,
        acceptance: request.acceptance,
      }),
      "utf8",
    )
    .digest("hex");
}

function turnFingerprint(prompt: string, thinkingLevel: TurnThinkingLevel): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        inputKind: "prompt",
        prompt,
        thinkingLevel,
      }),
      "utf8",
    )
    .digest("hex");
}

function traceId(runId: string): string {
  return createHash("sha256")
    .update("agent-dock.run-trace.v1\0", "utf8")
    .update(runId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function candidatePrompt(task: string, candidate: NormalizedCandidate, ordinal: number): string {
  const prompt = [
    task,
    "",
    `Candidate ${String(ordinal)} — ${candidate.label}`,
    candidate.strategy,
    "",
    "Work independently from the shared immutable baseline. Inspect the repository, implement the task, run the relevant deterministic checks, and report the result. Do not assume another candidate's changes are present.",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > 65_536) {
    throw new CandidateRaceError(
      "conflict",
      `Candidate ${String(ordinal)} execution prompt exceeds the bounded Turn size`,
    );
  }
  return prompt;
}

function pathProtected(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`),
  );
}

function effectiveTestResults(
  tests: ReturnType<typeof parseReviewBundleManifest>["tests"],
): ReturnType<typeof parseReviewBundleManifest>["tests"] {
  const latestByInvocation = new Map<string, (typeof tests)[number]>();
  for (const test of tests) {
    const invocation = classifyStructuredTestCommand(test.command);
    if (invocation !== undefined) latestByInvocation.set(invocation.key, test);
  }
  return [...latestByInvocation.values()];
}

function stateForDispatch(runState: RunState): OrchestrationDispatchState {
  if (runState === "cancelled") return "cancelled";
  if (TERMINAL_RUN_STATES.has(runState)) return "settled";
  if (ACTIVE_RUN_STATES.has(runState)) return "running";
  return "accepted";
}

function scorecardMetrics(value: unknown): {
  tests: { passed: number; failed: number; errored: number };
  changedPaths: number;
  costMicrousd: number;
  durationMs: number;
} {
  const parsed = value as {
    metrics?: {
      tests?: { passed?: unknown; failed?: unknown; errored?: unknown };
      changedPaths?: unknown;
      costMicrousd?: unknown;
      durationMs?: unknown;
    };
  };
  return {
    tests: {
      passed: nonNegativeInteger(parsed.metrics?.tests?.passed ?? 0, "Accepted-test count"),
      failed: nonNegativeInteger(parsed.metrics?.tests?.failed ?? 0, "Failed-test count"),
      errored: nonNegativeInteger(parsed.metrics?.tests?.errored ?? 0, "Errored-test count"),
    },
    changedPaths: nonNegativeInteger(
      parsed.metrics?.changedPaths ?? 0,
      "Accepted changed-path count",
    ),
    costMicrousd: nonNegativeInteger(parsed.metrics?.costMicrousd ?? 0, "Accepted candidate cost"),
    durationMs: nonNegativeInteger(parsed.metrics?.durationMs ?? 0, "Candidate duration"),
  };
}

export class CandidateRaceService {
  readonly #database: Kysely<Database>;
  readonly #controlPlaneStores: ControlPlaneStoreFactory;
  readonly #idGenerator: () => string;
  readonly #clock: () => Date;

  constructor(options: CandidateRaceServiceOptions) {
    this.#database = options.database;
    this.#controlPlaneStores = options.controlPlaneStores;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(
    identity: TenantRequestIdentity,
    parentSessionId: string,
    idempotencyKey: string,
    input: CreateCandidateRaceRequest,
  ): Promise<CandidateRaceResource> {
    const request = normalizeRequest(input);
    const fingerprint = requestFingerprint(request);
    const existing = await this.#database
      .selectFrom("orchestration_runs")
      .select(["id", "request_fingerprint"])
      .where("tenant_id", "=", identity.tenantId)
      .where("parent_session_id", "=", parentSessionId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing !== undefined) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new CandidateRaceError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different candidate race",
        );
      }
      return this.get(identity, existing.id);
    }

    const orchestrationId = this.#idGenerator();
    const gateId = this.#idGenerator();
    try {
      await this.#database.transaction().execute(async (transaction) => {
        const policy = await transaction
          .selectFrom("tenant_runtime_policies")
          .select([
            "enabled",
            "maximum_sessions",
            "maximum_unsettled_turns",
            "maximum_concurrent_turns",
          ])
          .where("tenant_id", "=", identity.tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (policy === undefined || !policy.enabled) {
          throw new CandidateRaceError(
            "control_plane_misconfigured",
            "Tenant runtime policy is unavailable",
          );
        }
        if (request.maximumConcurrentCandidates > policy.maximum_concurrent_turns) {
          throw new CandidateRaceError(
            "tenant_quota_exceeded",
            "Candidate-race concurrency exceeds the tenant concurrent-Run quota",
          );
        }

        const parent = await transaction
          .selectFrom("sessions")
          .select([
            "id",
            "project_id",
            "workspace_id",
            "desired_model_profile_id",
            "state",
            "current_workspace_version_id",
            "archived_at",
          ])
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", parentSessionId)
          .forUpdate()
          .executeTakeFirst();
        if (parent === undefined) {
          throw new CandidateRaceError("not_found", "Parent Session was not found");
        }
        if (parent.archived_at !== null) {
          throw new CandidateRaceError(
            "conflict",
            "Archived Session cannot start a candidate race",
          );
        }
        if (parent.state !== "cold" && parent.state !== "idle") {
          throw new CandidateRaceError(
            "conflict",
            "Parent Session must be cold or idle before fan-out",
          );
        }
        if (parent.current_workspace_version_id !== request.baseWorkspaceVersionId) {
          throw new CandidateRaceError(
            "conflict",
            "Parent Workspace changed after the candidate-race form was opened",
          );
        }
        const unsettledParent = await transaction
          .selectFrom("turns")
          .select("id")
          .where("tenant_id", "=", identity.tenantId)
          .where("session_id", "=", parentSessionId)
          .where("state", "in", [
            "queued",
            "dispatching",
            "running",
            "waiting_approval",
            "cancelling",
          ])
          .executeTakeFirst();
        if (unsettledParent !== undefined) {
          throw new CandidateRaceError(
            "conflict",
            "Parent Session has unsettled work and cannot be forked",
          );
        }

        const sessionCount = await transaction
          .selectFrom("sessions")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", identity.tenantId)
          .executeTakeFirstOrThrow();
        if (
          nonNegativeInteger(sessionCount.count, "Tenant Session count") +
            request.candidates.length >
          policy.maximum_sessions
        ) {
          throw new CandidateRaceError(
            "tenant_quota_exceeded",
            "Candidate race would exceed the tenant Session quota",
          );
        }
        const unsettledCount = await transaction
          .selectFrom("turns")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", identity.tenantId)
          .where("state", "in", [
            "queued",
            "dispatching",
            "running",
            "waiting_approval",
            "cancelling",
          ])
          .executeTakeFirstOrThrow();
        if (
          nonNegativeInteger(unsettledCount.count, "Tenant unsettled-Turn count") +
            request.candidates.length >
          policy.maximum_unsettled_turns
        ) {
          throw new CandidateRaceError(
            "tenant_quota_exceeded",
            "Candidate race would exceed the tenant unsettled-Turn quota",
          );
        }

        const base = await transaction
          .selectFrom("workspace_versions as version")
          .innerJoin("artifacts as pi", (join) =>
            join
              .onRef("pi.tenant_id", "=", "version.tenant_id")
              .onRef("pi.id", "=", "version.pi_artifact_id"),
          )
          .innerJoin("artifacts as workspace", (join) =>
            join
              .onRef("workspace.tenant_id", "=", "version.tenant_id")
              .onRef("workspace.id", "=", "version.workspace_artifact_id"),
          )
          .select([
            "version.id",
            "version.revision",
            "version.file_count",
            "version.pi_artifact_id",
            "version.workspace_artifact_id",
            "pi.object_key as piObjectKey",
            "workspace.object_key as workspaceObjectKey",
          ])
          .where("version.tenant_id", "=", identity.tenantId)
          .where("version.session_id", "=", parentSessionId)
          .where("version.id", "=", request.baseWorkspaceVersionId)
          .where("version.state", "=", "settled")
          .executeTakeFirst();
        if (base === undefined) {
          throw new CandidateRaceError("not_found", "Base Workspace version was not found");
        }

        const sourceResult = await sql<{ source_set_snapshot: unknown }>`
          with recursive version_ancestry as (
            select id, source_version_id, run_id, 0 as depth
            from workspace_versions
            where tenant_id = ${identity.tenantId}
              and id = ${base.id}
            union all
            select source.id, source.source_version_id, source.run_id, ancestry.depth + 1
            from workspace_versions as source
            inner join version_ancestry as ancestry
              on source.id = ancestry.source_version_id
            where ancestry.run_id is null
              and ancestry.depth < 32
          )
          select run.source_set_snapshot
          from version_ancestry as ancestry
          inner join runs as run
            on run.tenant_id = ${identity.tenantId}
            and run.id = ancestry.run_id
          order by ancestry.depth asc
          limit 1
        `.execute(transaction);
        const sourceSetValue = sourceResult.rows[0]?.source_set_snapshot;
        if (sourceSetValue === undefined) {
          throw new CandidateRaceError(
            "control_plane_misconfigured",
            "Base Workspace has no immutable source-set snapshot",
          );
        }
        const sourceSet = parseWorkspaceSourceSetSnapshot(sourceSetValue);

        const environment = await transaction
          .selectFrom("environment_versions")
          .select(["id", "state"])
          .where("tenant_id", "=", identity.tenantId)
          .where("project_id", "=", parent.project_id)
          .where("active", "=", true)
          .forUpdate()
          .executeTakeFirst();
        if (environment === undefined) {
          throw new CandidateRaceError(
            "control_plane_misconfigured",
            "Project has no active environment",
          );
        }
        if (environment.state === "failed") {
          throw new CandidateRaceError("conflict", "Active project environment failed validation");
        }

        const profileRow = await transaction
          .selectFrom("model_profiles as profile")
          .innerJoin("credential_bindings as credential", (join) =>
            join
              .onRef("credential.tenant_id", "=", "profile.tenant_id")
              .onRef("credential.id", "=", "profile.credential_binding_id")
              .onRef("credential.version", "=", "profile.credential_binding_version"),
          )
          .select([
            "profile.id",
            "profile.provider",
            "profile.model_id",
            "profile.default_thinking_level",
            "profile.allowed_thinking_levels",
            "profile.credential_binding_id",
            "profile.credential_binding_version",
            "profile.enabled",
            "credential.status as credentialStatus",
            "credential.provider as credentialProvider",
          ])
          .where("profile.tenant_id", "=", identity.tenantId)
          .where("profile.id", "=", parent.desired_model_profile_id)
          .executeTakeFirst();
        if (
          profileRow === undefined ||
          !profileRow.enabled ||
          profileRow.credentialStatus !== "active" ||
          profileRow.credentialProvider !== profileRow.provider
        ) {
          throw new CandidateRaceError(
            "control_plane_misconfigured",
            "Parent Session model profile is unavailable",
          );
        }
        let model;
        try {
          const profile: ModelProfile = {
            profileId: profileRow.id,
            provider: profileRow.provider,
            modelId: profileRow.model_id,
            defaultThinkingLevel: profileRow.default_thinking_level,
            allowedThinkingLevels: profileRow.allowed_thinking_levels,
            credentialBindingId: profileRow.credential_binding_id,
            credentialBindingVersion: positiveInteger(
              profileRow.credential_binding_version,
              "Credential binding version",
            ),
            enabled: profileRow.enabled,
          };
          model = resolveTurnModel(profile, request.thinkingLevel);
        } catch (error) {
          if (error instanceof DomainModelValidationError) {
            throw new CandidateRaceError("conflict", error.message);
          }
          throw error;
        }

        await transaction
          .insertInto("orchestration_runs")
          .values({
            id: orchestrationId,
            tenant_id: identity.tenantId,
            project_id: parent.project_id,
            workspace_id: parent.workspace_id,
            parent_session_id: parent.id,
            base_workspace_version_id: base.id,
            kind: "candidate_race",
            state: "running",
            prompt: request.prompt,
            candidate_specs: {
              schemaVersion: 1,
              candidates: request.candidates,
              thinkingLevel: request.thinkingLevel ?? null,
            },
            acceptance_policy: request.acceptance,
            candidate_count: request.candidates.length,
            maximum_concurrent_candidates: request.maximumConcurrentCandidates,
            created_by_user_id: identity.userId,
            idempotency_key: idempotencyKey,
            request_fingerprint: fingerprint,
            winner_candidate_id: null,
            cancel_idempotency_key: null,
            cancel_requested_by_user_id: null,
            cancel_requested_at: null,
            settled_at: null,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("orchestration_decision_gates")
          .values({
            id: gateId,
            tenant_id: identity.tenantId,
            orchestration_id: orchestrationId,
            state: "pending",
            selected_candidate_id: null,
            resolved_by_user_id: null,
            resolved_at: null,
          })
          .executeTakeFirstOrThrow();

        for (const [index, candidate] of request.candidates.entries()) {
          const ordinal = index + 1;
          const childSessionId = this.#idGenerator();
          const childVersionId = this.#idGenerator();
          const workspaceOperationId = this.#idGenerator();
          const turnId = this.#idGenerator();
          const commandId = this.#idGenerator();
          const runId = this.#idGenerator();
          const outboxId = this.#idGenerator();
          const candidateId = this.#idGenerator();
          const dispatchId = this.#idGenerator();
          const executionPrompt = candidatePrompt(request.prompt, candidate, ordinal);
          const commandIdempotencyKey = `race:${orchestrationId}:${String(ordinal)}:turn`;

          await transaction
            .insertInto("sessions")
            .values({
              id: childSessionId,
              tenant_id: identity.tenantId,
              project_id: parent.project_id,
              workspace_id: parent.workspace_id,
              desired_model_profile_id: parent.desired_model_profile_id,
              state: "cold",
              pi_session_snapshot_key: base.piObjectKey,
              workspace_snapshot_key: base.workspaceObjectKey,
              current_workspace_version_id: null,
              forked_from_session_id: parent.id,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("session_event_cursors")
            .values({ session_id: childSessionId })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("workspace_versions")
            .values({
              id: childVersionId,
              tenant_id: identity.tenantId,
              workspace_id: parent.workspace_id,
              session_id: childSessionId,
              version_number: 1,
              parent_version_id: null,
              source_version_id: base.id,
              origin_kind: "fork",
              run_id: null,
              attempt_id: null,
              turn_id: null,
              pi_artifact_id: base.pi_artifact_id,
              workspace_artifact_id: base.workspace_artifact_id,
              patch_artifact_id: null,
              revision: base.revision,
              file_count: base.file_count,
              state: "settled",
              settled_at: sql<Date>`now()`,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .updateTable("sessions")
            .set({
              current_workspace_version_id: childVersionId,
              next_mailbox_position: 2,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
              updated_at: sql<Date>`now()`,
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("id", "=", childSessionId)
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("workspace_operations")
            .values({
              id: workspaceOperationId,
              tenant_id: identity.tenantId,
              session_id: parent.id,
              kind: "fork",
              idempotency_key: `race:${orchestrationId}:${String(ordinal)}:fork`,
              from_version_id: base.id,
              to_version_id: childVersionId,
              source_session_id: parent.id,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("turns")
            .values({
              id: turnId,
              tenant_id: identity.tenantId,
              session_id: childSessionId,
              state: "queued",
              input_kind: "prompt",
              input_text: executionPrompt,
              model_profile_id: model.profileId,
              provider: model.provider,
              model_id: model.modelId,
              thinking_level: model.thinkingLevel,
              credential_binding_id: model.credentialBindingId,
              credential_binding_version: model.credentialBindingVersion,
              stop_reason: null,
              failure_code: null,
              failure_message: null,
              failure_retryable: null,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("commands")
            .values({
              id: commandId,
              tenant_id: identity.tenantId,
              session_id: childSessionId,
              turn_id: turnId,
              idempotency_key: commandIdempotencyKey,
              kind: "turn.execute",
              state: "pending",
              mailbox_position: 1,
              payload: {
                schemaVersion: 1,
                requestHash: turnFingerprint(executionPrompt, model.thinkingLevel),
                orchestrationId,
                candidateOrdinal: ordinal,
              },
              dispatched_at: null,
              acknowledged_at: null,
              completed_at: null,
              failure_code: null,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("runs")
            .values({
              id: runId,
              trace_id: traceId(runId),
              tenant_id: identity.tenantId,
              project_id: parent.project_id,
              workspace_id: parent.workspace_id,
              session_id: childSessionId,
              turn_id: turnId,
              command_id: commandId,
              environment_version_id: environment.id,
              source_set_snapshot: sql<Record<string, unknown>>`${canonicalWorkspaceSourceSetJson(
                sourceSet,
              )}::jsonb`,
              conversation_base_seq: 0,
              workspace_base_version_id: childVersionId,
              pi_session_base_artifact_id: base.pi_artifact_id,
              idempotency_key: commandIdempotencyKey,
              state: "queued",
              current_attempt_id: null,
              attempt_count: 0,
              stop_reason: null,
              failure_code: null,
              failure_message: null,
              failure_retryable: null,
              started_at: null,
              settled_at: null,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("outbox")
            .values({
              id: outboxId,
              tenant_id: identity.tenantId,
              aggregate_type: "session",
              aggregate_id: childSessionId,
              topic: TURN_COMMAND_OUTBOX_TOPIC,
              payload: {
                schemaVersion: 1,
                commandId,
                sessionId: childSessionId,
                turnId,
                kind: "turn.execute",
              },
              published_at: null,
              last_error: null,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("orchestration_candidates")
            .values({
              id: candidateId,
              tenant_id: identity.tenantId,
              orchestration_id: orchestrationId,
              ordinal,
              label: candidate.label,
              strategy: candidate.strategy,
              child_session_id: childSessionId,
              run_id: runId,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("orchestration_dispatches")
            .values({
              id: dispatchId,
              tenant_id: identity.tenantId,
              orchestration_id: orchestrationId,
              candidate_id: candidateId,
              run_id: runId,
              generation: 1,
              state: "accepted",
              settled_at: null,
            })
            .executeTakeFirstOrThrow();
        }
      });
    } catch (error) {
      if (isUniqueConstraint(error, "orchestration_runs_parent_key_unique")) {
        const winner = await this.#database
          .selectFrom("orchestration_runs")
          .select(["id", "request_fingerprint"])
          .where("tenant_id", "=", identity.tenantId)
          .where("parent_session_id", "=", parentSessionId)
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirstOrThrow();
        if (winner.request_fingerprint !== fingerprint) {
          throw new CandidateRaceError(
            "idempotency_conflict",
            "Idempotency-Key was already used for a different candidate race",
          );
        }
        return this.get(identity, winner.id);
      }
      throw error;
    }
    return this.get(identity, orchestrationId);
  }

  async list(
    identity: TenantRequestIdentity,
    parentSessionId: string,
  ): Promise<CandidateRaceListResource> {
    const parent = await this.#database
      .selectFrom("sessions")
      .select("id")
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", parentSessionId)
      .executeTakeFirst();
    if (parent === undefined) throw new CandidateRaceError("not_found", "Session was not found");
    const rows = await this.#database
      .selectFrom("orchestration_runs")
      .select("id")
      .where("tenant_id", "=", identity.tenantId)
      .where("parent_session_id", "=", parentSessionId)
      .orderBy("created_at", "desc")
      .limit(MAX_LISTED_RACES + 1)
      .execute();
    const visible = rows.slice(0, MAX_LISTED_RACES);
    return {
      races: await Promise.all(visible.map((row) => this.get(identity, row.id))),
      truncated: rows.length > MAX_LISTED_RACES,
    };
  }

  async get(
    identity: TenantRequestIdentity,
    orchestrationId: string,
  ): Promise<CandidateRaceResource> {
    await this.#refresh(identity, orchestrationId);
    return this.#loadResource(identity.tenantId, orchestrationId);
  }

  async cancel(
    identity: TenantRequestIdentity,
    orchestrationId: string,
    idempotencyKey: string,
  ): Promise<CandidateRaceResource> {
    const now = safeDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const race = await transaction
        .selectFrom("orchestration_runs")
        .select(["state", "cancel_idempotency_key"])
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", orchestrationId)
        .forUpdate()
        .executeTakeFirst();
      if (race === undefined) throw new CandidateRaceError("not_found", "Candidate race not found");
      if (race.cancel_idempotency_key !== null && race.cancel_idempotency_key !== idempotencyKey) {
        throw new CandidateRaceError(
          "idempotency_conflict",
          "Candidate race already has a different cancellation request",
        );
      }
      if (race.state === "completed" || race.state === "failed" || race.state === "cancelled") {
        if (race.cancel_idempotency_key === idempotencyKey) return;
        throw new CandidateRaceError("conflict", "Terminal candidate race cannot be cancelled");
      }
      await transaction
        .updateTable("orchestration_runs")
        .set({
          state: "cancel_requested",
          cancel_idempotency_key: idempotencyKey,
          cancel_requested_by_user_id: identity.userId,
          cancel_requested_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", orchestrationId)
        .executeTakeFirstOrThrow();
      await this.#withdrawQueuedCandidates(transaction, identity.tenantId, orchestrationId, now);
    });

    const active = await this.#database
      .selectFrom("orchestration_candidates as candidate")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "candidate.tenant_id")
          .onRef("run.id", "=", "candidate.run_id"),
      )
      .innerJoin("turns as turn", (join) =>
        join.onRef("turn.tenant_id", "=", "run.tenant_id").onRef("turn.id", "=", "run.turn_id"),
      )
      .select(["candidate.id", "candidate.child_session_id", "turn.id as turnId", "turn.state"])
      .where("candidate.tenant_id", "=", identity.tenantId)
      .where("candidate.orchestration_id", "=", orchestrationId)
      .where("turn.state", "in", ["running", "waiting_approval"])
      .execute();
    const store = this.#controlPlaneStores.forIdentity(identity);
    await Promise.all(
      active.map(async (candidate) => {
        try {
          await store.acceptTurnCancellation(
            candidate.child_session_id,
            candidate.turnId,
            `race-cancel:${orchestrationId}:${candidate.id}`,
            { gracePeriodMs: 2_000 },
          );
        } catch (error) {
          if (
            error instanceof ControlPlaneStoreError &&
            (error.code === "conflict" || error.code === "not_found")
          ) {
            return;
          }
          throw error;
        }
      }),
    );
    await this.#refresh(identity, orchestrationId);
    return this.#loadResource(identity.tenantId, orchestrationId);
  }

  async promote(
    identity: TenantRequestIdentity,
    orchestrationId: string,
    idempotencyKey: string,
    request: PromoteCandidateRequest,
  ): Promise<CandidateRaceResource> {
    await this.#refresh(identity, orchestrationId);
    const promotionId = this.#idGenerator();
    const promotedVersionId = this.#idGenerator();
    const workspaceOperationId = this.#idGenerator();
    const now = safeDate(this.#clock);
    try {
      await this.#database.transaction().execute(async (transaction) => {
        const existing = await transaction
          .selectFrom("candidate_promotions")
          .select(["orchestration_id", "candidate_id", "from_workspace_version_id"])
          .where("tenant_id", "=", identity.tenantId)
          .where("parent_session_id", "in", (query) =>
            query
              .selectFrom("orchestration_runs")
              .select("parent_session_id")
              .where("tenant_id", "=", identity.tenantId)
              .where("id", "=", orchestrationId),
          )
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (existing !== undefined) {
          if (
            existing.orchestration_id !== orchestrationId ||
            existing.candidate_id !== request.candidateId ||
            existing.from_workspace_version_id !== request.expectedParentWorkspaceVersionId
          ) {
            throw new CandidateRaceError(
              "idempotency_conflict",
              "Idempotency-Key was already used for a different candidate promotion",
            );
          }
          return;
        }

        const race = await transaction
          .selectFrom("orchestration_runs")
          .select([
            "state",
            "parent_session_id",
            "workspace_id",
            "base_workspace_version_id",
            "winner_candidate_id",
          ])
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", orchestrationId)
          .forUpdate()
          .executeTakeFirst();
        if (race === undefined)
          throw new CandidateRaceError("not_found", "Candidate race not found");
        if (race.state === "completed" && race.winner_candidate_id === request.candidateId) return;
        if (race.state !== "awaiting_decision") {
          throw new CandidateRaceError(
            "conflict",
            "Candidate race is not awaiting a winner decision",
          );
        }
        if (race.base_workspace_version_id !== request.expectedParentWorkspaceVersionId) {
          throw new CandidateRaceError(
            "conflict",
            "Promotion expected version does not match the race baseline",
          );
        }
        const candidate = await transaction
          .selectFrom("orchestration_candidates as candidate")
          .innerJoin("orchestration_acceptance_results as acceptance", (join) =>
            join
              .onRef("acceptance.tenant_id", "=", "candidate.tenant_id")
              .onRef("acceptance.candidate_id", "=", "candidate.id"),
          )
          .select([
            "candidate.id",
            "candidate.child_session_id",
            "acceptance.verdict",
            "acceptance.workspace_version_id",
          ])
          .where("candidate.tenant_id", "=", identity.tenantId)
          .where("candidate.orchestration_id", "=", orchestrationId)
          .where("candidate.id", "=", request.candidateId)
          .executeTakeFirst();
        if (candidate === undefined) {
          throw new CandidateRaceError("not_found", "Candidate was not found");
        }
        if (candidate.verdict !== "passed" || candidate.workspace_version_id === null) {
          throw new CandidateRaceError(
            "conflict",
            "Only a passing candidate with a settled Workspace can be promoted",
          );
        }

        const parent = await transaction
          .selectFrom("sessions")
          .select(["state", "current_workspace_version_id", "row_version", "archived_at"])
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", race.parent_session_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (parent.archived_at !== null || (parent.state !== "cold" && parent.state !== "idle")) {
          throw new CandidateRaceError(
            "conflict",
            "Parent Session must be active and idle before promotion",
          );
        }
        if (parent.current_workspace_version_id !== request.expectedParentWorkspaceVersionId) {
          throw new CandidateRaceError(
            "conflict",
            "Parent Workspace changed while candidates were running",
          );
        }
        const parentUnsettled = await transaction
          .selectFrom("turns")
          .select("id")
          .where("tenant_id", "=", identity.tenantId)
          .where("session_id", "=", race.parent_session_id)
          .where("state", "in", [
            "queued",
            "dispatching",
            "running",
            "waiting_approval",
            "cancelling",
          ])
          .executeTakeFirst();
        if (parentUnsettled !== undefined) {
          throw new CandidateRaceError(
            "conflict",
            "Parent Session has unsettled work and cannot accept promotion",
          );
        }
        const base = await transaction
          .selectFrom("workspace_versions as version")
          .innerJoin("artifacts as pi", (join) =>
            join
              .onRef("pi.tenant_id", "=", "version.tenant_id")
              .onRef("pi.id", "=", "version.pi_artifact_id"),
          )
          .select(["version.pi_artifact_id", "pi.object_key as piObjectKey"])
          .where("version.tenant_id", "=", identity.tenantId)
          .where("version.session_id", "=", race.parent_session_id)
          .where("version.id", "=", request.expectedParentWorkspaceVersionId)
          .where("version.state", "=", "settled")
          .executeTakeFirstOrThrow();
        const selected = await transaction
          .selectFrom("workspace_versions as version")
          .innerJoin("artifacts as workspace", (join) =>
            join
              .onRef("workspace.tenant_id", "=", "version.tenant_id")
              .onRef("workspace.id", "=", "version.workspace_artifact_id"),
          )
          .select([
            "version.id",
            "version.workspace_artifact_id",
            "version.patch_artifact_id",
            "version.revision",
            "version.file_count",
            "workspace.object_key as workspaceObjectKey",
          ])
          .where("version.tenant_id", "=", identity.tenantId)
          .where("version.session_id", "=", candidate.child_session_id)
          .where("version.id", "=", candidate.workspace_version_id)
          .where("version.state", "=", "settled")
          .executeTakeFirst();
        if (selected === undefined) {
          throw new CandidateRaceError(
            "control_plane_misconfigured",
            "Accepted candidate Workspace version is unavailable",
          );
        }
        const maxVersion = await transaction
          .selectFrom("workspace_versions")
          .select((expression) => expression.fn.max<number>("version_number").as("maximum"))
          .where("tenant_id", "=", identity.tenantId)
          .where("session_id", "=", race.parent_session_id)
          .executeTakeFirstOrThrow();
        const nextVersionNumber =
          nonNegativeInteger(maxVersion.maximum ?? 0, "Parent Workspace version number") + 1;

        await transaction
          .insertInto("workspace_versions")
          .values({
            id: promotedVersionId,
            tenant_id: identity.tenantId,
            workspace_id: race.workspace_id,
            session_id: race.parent_session_id,
            version_number: nextVersionNumber,
            parent_version_id: request.expectedParentWorkspaceVersionId,
            source_version_id: selected.id,
            origin_kind: "promotion",
            run_id: null,
            attempt_id: null,
            turn_id: null,
            pi_artifact_id: base.pi_artifact_id,
            workspace_artifact_id: selected.workspace_artifact_id,
            patch_artifact_id: selected.patch_artifact_id,
            revision: selected.revision,
            file_count: selected.file_count,
            state: "settled",
            settled_at: now,
          })
          .executeTakeFirstOrThrow();
        const workspaceUpdated = await transaction
          .updateTable("workspaces")
          .set({
            current_workspace_version_id: promotedVersionId,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", race.workspace_id)
          .where("current_workspace_version_id", "=", request.expectedParentWorkspaceVersionId)
          .executeTakeFirst();
        if (workspaceUpdated.numUpdatedRows !== 1n) {
          throw new CandidateRaceError(
            "conflict",
            "Parent Workspace changed while the promotion was committing",
          );
        }
        const updated = await transaction
          .updateTable("sessions")
          .set({
            current_workspace_version_id: promotedVersionId,
            pi_session_snapshot_key: base.piObjectKey,
            workspace_snapshot_key: selected.workspaceObjectKey,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", race.parent_session_id)
          .where("row_version", "=", parent.row_version)
          .where("current_workspace_version_id", "=", request.expectedParentWorkspaceVersionId)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new CandidateRaceError(
            "conflict",
            "Parent Workspace changed while the promotion was committing",
          );
        }
        await transaction
          .updateTable("sessions")
          .set({
            current_workspace_version_id: promotedVersionId,
            workspace_snapshot_key: selected.workspaceObjectKey,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("workspace_id", "=", race.workspace_id)
          .where("id", "!=", race.parent_session_id)
          .where("forked_from_session_id", "is", null)
          .execute();
        await transaction
          .insertInto("workspace_operations")
          .values({
            id: workspaceOperationId,
            tenant_id: identity.tenantId,
            session_id: race.parent_session_id,
            kind: "promote",
            idempotency_key: idempotencyKey,
            from_version_id: request.expectedParentWorkspaceVersionId,
            to_version_id: promotedVersionId,
            source_session_id: candidate.child_session_id,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("candidate_promotions")
          .values({
            id: promotionId,
            tenant_id: identity.tenantId,
            orchestration_id: orchestrationId,
            candidate_id: candidate.id,
            parent_session_id: race.parent_session_id,
            from_workspace_version_id: request.expectedParentWorkspaceVersionId,
            candidate_workspace_version_id: selected.id,
            promoted_workspace_version_id: promotedVersionId,
            actor_user_id: identity.userId,
            idempotency_key: idempotencyKey,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("orchestration_decision_gates")
          .set({
            state: "resolved",
            selected_candidate_id: candidate.id,
            resolved_by_user_id: identity.userId,
            resolved_at: now,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("orchestration_id", "=", orchestrationId)
          .where("state", "=", "pending")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("orchestration_runs")
          .set({
            state: "completed",
            winner_candidate_id: candidate.id,
            updated_at: now,
            settled_at: now,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", orchestrationId)
          .where("state", "=", "awaiting_decision")
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (
        isUniqueConstraint(error, "candidate_promotions_orchestration_unique") ||
        isUniqueConstraint(error, "candidate_promotions_parent_key_unique")
      ) {
        const existing = await this.#database
          .selectFrom("candidate_promotions")
          .select(["candidate_id", "from_workspace_version_id", "idempotency_key"])
          .where("tenant_id", "=", identity.tenantId)
          .where("orchestration_id", "=", orchestrationId)
          .executeTakeFirstOrThrow();
        if (
          existing.candidate_id !== request.candidateId ||
          existing.from_workspace_version_id !== request.expectedParentWorkspaceVersionId ||
          existing.idempotency_key !== idempotencyKey
        ) {
          throw new CandidateRaceError(
            "idempotency_conflict",
            "Candidate race was already promoted through a different decision",
          );
        }
      } else {
        throw error;
      }
    }
    return this.#loadResource(identity.tenantId, orchestrationId);
  }

  async #withdrawQueuedCandidates(
    transaction: Transaction<Database>,
    tenantId: string,
    orchestrationId: string,
    now: Date,
  ): Promise<void> {
    const rows = await transaction
      .selectFrom("orchestration_candidates as candidate")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "candidate.tenant_id")
          .onRef("run.id", "=", "candidate.run_id"),
      )
      .innerJoin("turns as turn", (join) =>
        join.onRef("turn.tenant_id", "=", "run.tenant_id").onRef("turn.id", "=", "run.turn_id"),
      )
      .innerJoin("commands as command", (join) =>
        join
          .onRef("command.tenant_id", "=", "run.tenant_id")
          .onRef("command.id", "=", "run.command_id"),
      )
      .innerJoin("outbox", (join) =>
        join
          .onRef("outbox.tenant_id", "=", "run.tenant_id")
          .on(
            sql<boolean>`${sql.ref("command.id")}::text = ${sql.ref("outbox.payload")} ->> 'commandId'`,
          ),
      )
      .select([
        "candidate.id as candidateId",
        "run.id as runId",
        "turn.id as turnId",
        "command.id as commandId",
        "outbox.id as outboxId",
      ])
      .where("candidate.tenant_id", "=", tenantId)
      .where("candidate.orchestration_id", "=", orchestrationId)
      .where("run.state", "=", "queued")
      .where("turn.state", "=", "queued")
      .where("command.state", "=", "pending")
      .forUpdate(["run", "turn", "command", "outbox"])
      .execute();
    for (const row of rows) {
      await transaction
        .updateTable("turns")
        .set({ state: "cancelling" })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", row.turnId)
        .where("state", "=", "queued")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({
          state: "cancelled",
          stop_reason: "orchestration_cancelled",
          settled_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", row.turnId)
        .where("state", "=", "cancelling")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("commands")
        .set({
          state: "failed",
          failure_code: "orchestration_cancelled",
          completed_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", row.commandId)
        .where("state", "=", "pending")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({
          state: "cancel_requested",
          stop_reason: "orchestration_cancelled",
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", row.runId)
        .where("state", "=", "queued")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({
          state: "cancelled",
          settled_at: now,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", row.runId)
        .where("state", "=", "cancel_requested")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("outbox")
        .set({
          published_at: now,
          last_error: "orchestration_cancelled_before_dispatch",
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", row.outboxId)
        .where("published_at", "is", null)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("orchestration_dispatches")
        .set({ state: "cancelled", settled_at: now })
        .where("tenant_id", "=", tenantId)
        .where("candidate_id", "=", row.candidateId)
        .where("state", "=", "accepted")
        .executeTakeFirstOrThrow();
    }
  }

  async #refresh(identity: TenantRequestIdentity, orchestrationId: string): Promise<void> {
    const race = await this.#database
      .selectFrom("orchestration_runs")
      .select(["state", "candidate_count", "acceptance_policy"])
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", orchestrationId)
      .executeTakeFirst();
    if (race === undefined) throw new CandidateRaceError("not_found", "Candidate race not found");
    const policy = parseCandidateRaceAcceptancePolicy(race.acceptance_policy);
    const candidates = await this.#database
      .selectFrom("orchestration_candidates as candidate")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "candidate.tenant_id")
          .onRef("run.id", "=", "candidate.run_id"),
      )
      .leftJoin("orchestration_acceptance_results as acceptance", (join) =>
        join
          .onRef("acceptance.tenant_id", "=", "candidate.tenant_id")
          .onRef("acceptance.candidate_id", "=", "candidate.id"),
      )
      .select([
        "candidate.id as candidateId",
        "candidate.child_session_id as childSessionId",
        "candidate.run_id as runId",
        "run.state as runState",
        "run.queued_at as queuedAt",
        "run.settled_at as settledAt",
        "acceptance.candidate_id as evaluatedCandidateId",
      ])
      .where("candidate.tenant_id", "=", identity.tenantId)
      .where("candidate.orchestration_id", "=", orchestrationId)
      .orderBy("candidate.ordinal", "asc")
      .execute();
    if (candidates.length !== race.candidate_count) {
      throw new CandidateRaceError(
        "control_plane_misconfigured",
        "Candidate race does not contain its declared candidates",
      );
    }
    for (const candidate of candidates) {
      const dispatchState = stateForDispatch(candidate.runState);
      await this.#database
        .updateTable("orchestration_dispatches")
        .set({
          state: dispatchState,
          settled_at:
            dispatchState === "settled" || dispatchState === "cancelled"
              ? (candidate.settledAt ?? safeDate(this.#clock))
              : null,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("candidate_id", "=", candidate.candidateId)
        .executeTakeFirstOrThrow();
      if (candidate.evaluatedCandidateId === null && TERMINAL_RUN_STATES.has(candidate.runState)) {
        await this.#evaluateCandidate(identity, orchestrationId, candidate, policy);
      }
    }

    const summary = await this.#database
      .selectFrom("orchestration_candidates as candidate")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "candidate.tenant_id")
          .onRef("run.id", "=", "candidate.run_id"),
      )
      .leftJoin("orchestration_acceptance_results as acceptance", (join) =>
        join
          .onRef("acceptance.tenant_id", "=", "candidate.tenant_id")
          .onRef("acceptance.candidate_id", "=", "candidate.id"),
      )
      .select((expression) => [
        expression.fn.countAll<string>().as("total"),
        expression.fn.count<string>("acceptance.candidate_id").as("evaluated"),
        expression.fn
          .count<string>("acceptance.candidate_id")
          .filterWhere("acceptance.verdict", "=", "passed")
          .as("passed"),
        expression.fn
          .count<string>("run.id")
          .filterWhere("run.state", "in", [
            "completed",
            "interrupted",
            "failed",
            "cancelled",
            "timed_out",
            "superseded",
          ])
          .as("terminal"),
      ])
      .where("candidate.tenant_id", "=", identity.tenantId)
      .where("candidate.orchestration_id", "=", orchestrationId)
      .executeTakeFirstOrThrow();
    const total = nonNegativeInteger(summary.total, "Candidate count");
    const evaluated = nonNegativeInteger(summary.evaluated, "Evaluated candidate count");
    const passed = nonNegativeInteger(summary.passed, "Passing candidate count");
    const terminal = nonNegativeInteger(summary.terminal, "Terminal candidate count");
    const now = safeDate(this.#clock);
    if (race.state === "running" && total === evaluated) {
      const nextState: OrchestrationState = passed > 0 ? "awaiting_decision" : "failed";
      await this.#database
        .updateTable("orchestration_runs")
        .set({
          state: nextState,
          updated_at: now,
          settled_at: nextState === "failed" ? now : null,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", orchestrationId)
        .where("state", "=", "running")
        .executeTakeFirstOrThrow();
      if (nextState === "failed") {
        await this.#database
          .updateTable("orchestration_decision_gates")
          .set({ state: "cancelled", resolved_at: now })
          .where("tenant_id", "=", identity.tenantId)
          .where("orchestration_id", "=", orchestrationId)
          .where("state", "=", "pending")
          .executeTakeFirstOrThrow();
      }
    } else if (race.state === "cancel_requested" && terminal === total) {
      await this.#database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("orchestration_runs")
          .set({ state: "cancelled", updated_at: now, settled_at: now })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", orchestrationId)
          .where("state", "=", "cancel_requested")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("orchestration_decision_gates")
          .set({ state: "cancelled", resolved_at: now })
          .where("tenant_id", "=", identity.tenantId)
          .where("orchestration_id", "=", orchestrationId)
          .where("state", "=", "pending")
          .executeTakeFirstOrThrow();
      });
    }
  }

  async #evaluateCandidate(
    identity: TenantRequestIdentity,
    orchestrationId: string,
    candidate: {
      candidateId: string;
      childSessionId: string;
      runId: string;
      runState: RunState;
      queuedAt: Date | string;
      settledAt: Date | string | null;
    },
    policy: CandidateRaceAcceptancePolicy,
  ): Promise<void> {
    const currentVersion = await this.#database
      .selectFrom("sessions")
      .select("current_workspace_version_id")
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", candidate.childSessionId)
      .executeTakeFirstOrThrow();
    let verdict: OrchestrationAcceptanceVerdict = "failed";
    let reviewBundleId: string | null = null;
    let workspaceVersionId = currentVersion.current_workspace_version_id;
    let scorecard: Record<string, unknown>;

    if (candidate.runState === "completed") {
      let bundle;
      try {
        bundle = await this.#controlPlaneStores
          .forIdentity(identity)
          .getReviewBundle(candidate.runId);
      } catch (error) {
        if (error instanceof ControlPlaneStoreError && error.code === "not_found") return;
        throw error;
      }
      const manifest = parseReviewBundleManifest(bundle.manifest);
      reviewBundleId = bundle.reviewBundleId;
      workspaceVersionId = manifest.changes.workspaceVersionId ?? workspaceVersionId;
      const effectiveTests = effectiveTestResults(manifest.tests);
      const testCounts = {
        total: effectiveTests.length,
        passed: effectiveTests.filter((test) => test.status === "passed").length,
        failed: effectiveTests.filter((test) => test.status === "failed").length,
        errored: effectiveTests.filter((test) => test.status === "errored").length,
      };
      const reasons: string[] = [];
      if (
        policy.requirePatch &&
        (manifest.changes.patchArtifactId === undefined ||
          manifest.changes.changedPaths.length === 0)
      ) {
        reasons.push("required_patch_missing");
      }
      if (policy.requireTests && testCounts.total === 0) reasons.push("required_tests_missing");
      if (testCounts.failed > 0 || testCounts.errored > 0) reasons.push("tests_not_green");
      if (manifest.changes.changedPaths.length > policy.maximumChangedPaths) {
        reasons.push("changed_path_limit_exceeded");
      }
      if (
        manifest.changes.changedPaths.some((path) =>
          pathProtected(path, policy.protectedPathPrefixes),
        )
      ) {
        reasons.push("protected_path_changed");
      }
      verdict = reasons.length === 0 ? "passed" : "failed";
      const durationMs = Math.max(
        0,
        new Date(manifest.run.settledAt).valueOf() - new Date(manifest.run.queuedAt).valueOf(),
      );
      scorecard = {
        reasons,
        metrics: {
          runState: candidate.runState,
          changedPaths: manifest.changes.changedPaths.length,
          tests: testCounts,
          modelRequests: manifest.usage.requests,
          tokens:
            manifest.usage.inputTokens +
            manifest.usage.outputTokens +
            manifest.usage.cacheReadTokens +
            manifest.usage.cacheWriteTokens,
          costMicrousd: manifest.usage.costMicrousd,
          durationMs,
        },
      };
    } else {
      const usage = await this.#database
        .selectFrom("usage_ledger")
        .select((expression) => [
          expression.fn.countAll<string>().as("requests"),
          expression.fn
            .coalesce(expression.fn.sum<string>("input_tokens"), sql<string>`0`)
            .as("input"),
          expression.fn
            .coalesce(expression.fn.sum<string>("output_tokens"), sql<string>`0`)
            .as("output"),
          expression.fn
            .coalesce(expression.fn.sum<string>("cache_read_tokens"), sql<string>`0`)
            .as("cacheRead"),
          expression.fn
            .coalesce(expression.fn.sum<string>("cache_write_tokens"), sql<string>`0`)
            .as("cacheWrite"),
          expression.fn
            .coalesce(expression.fn.sum<string>("cost_microusd"), sql<string>`0`)
            .as("cost"),
        ])
        .where("tenant_id", "=", identity.tenantId)
        .where("run_id", "=", candidate.runId)
        .executeTakeFirstOrThrow();
      const durationMs =
        candidate.settledAt === null
          ? 0
          : Math.max(
              0,
              new Date(candidate.settledAt).valueOf() - new Date(candidate.queuedAt).valueOf(),
            );
      scorecard = {
        reasons: [`run_${candidate.runState}`],
        metrics: {
          runState: candidate.runState,
          changedPaths: 0,
          tests: { total: 0, passed: 0, failed: 0, errored: 0 },
          modelRequests: nonNegativeInteger(usage.requests, "Candidate model-request count"),
          tokens:
            nonNegativeInteger(usage.input, "Candidate input tokens") +
            nonNegativeInteger(usage.output, "Candidate output tokens") +
            nonNegativeInteger(usage.cacheRead, "Candidate cache-read tokens") +
            nonNegativeInteger(usage.cacheWrite, "Candidate cache-write tokens"),
          costMicrousd: nonNegativeInteger(usage.cost, "Candidate cost"),
          durationMs,
        },
      };
    }
    await this.#database
      .insertInto("orchestration_acceptance_results")
      .values({
        candidate_id: candidate.candidateId,
        tenant_id: identity.tenantId,
        orchestration_id: orchestrationId,
        verdict,
        review_bundle_id: reviewBundleId,
        workspace_version_id: workspaceVersionId,
        scorecard,
      })
      .onConflict((conflict) => conflict.column("candidate_id").doNothing())
      .execute();
  }

  async #loadResource(tenantId: string, orchestrationId: string): Promise<CandidateRaceResource> {
    const race = await this.#database
      .selectFrom("orchestration_runs as race")
      .innerJoin("orchestration_decision_gates as gate", (join) =>
        join
          .onRef("gate.tenant_id", "=", "race.tenant_id")
          .onRef("gate.orchestration_id", "=", "race.id"),
      )
      .leftJoin("candidate_promotions as promotion", (join) =>
        join
          .onRef("promotion.tenant_id", "=", "race.tenant_id")
          .onRef("promotion.orchestration_id", "=", "race.id"),
      )
      .select([
        "race.id",
        "race.kind",
        "race.state",
        "race.project_id",
        "race.workspace_id",
        "race.parent_session_id",
        "race.base_workspace_version_id",
        "race.prompt",
        "race.maximum_concurrent_candidates",
        "race.acceptance_policy",
        "race.winner_candidate_id",
        "race.cancel_requested_at",
        "race.created_at",
        "race.updated_at",
        "race.settled_at",
        "gate.id as gateId",
        "gate.state as gateState",
        "gate.selected_candidate_id as selectedCandidateId",
        "gate.resolved_at as gateResolvedAt",
        "promotion.promoted_workspace_version_id as promotedWorkspaceVersionId",
      ])
      .where("race.tenant_id", "=", tenantId)
      .where("race.id", "=", orchestrationId)
      .executeTakeFirst();
    if (race === undefined) throw new CandidateRaceError("not_found", "Candidate race not found");
    const candidateRows = await this.#database
      .selectFrom("orchestration_candidates as candidate")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "candidate.tenant_id")
          .onRef("run.id", "=", "candidate.run_id"),
      )
      .innerJoin("orchestration_dispatches as dispatch", (join) =>
        join
          .onRef("dispatch.tenant_id", "=", "candidate.tenant_id")
          .onRef("dispatch.candidate_id", "=", "candidate.id"),
      )
      .leftJoin("orchestration_acceptance_results as acceptance", (join) =>
        join
          .onRef("acceptance.tenant_id", "=", "candidate.tenant_id")
          .onRef("acceptance.candidate_id", "=", "candidate.id"),
      )
      .select([
        "candidate.id",
        "candidate.ordinal",
        "candidate.label",
        "candidate.strategy",
        "candidate.child_session_id",
        "candidate.run_id",
        "candidate.created_at",
        "run.state as runState",
        "dispatch.id as dispatchId",
        "dispatch.generation as dispatchGeneration",
        "dispatch.state as dispatchState",
        "acceptance.verdict",
        "acceptance.review_bundle_id as reviewBundleId",
        "acceptance.workspace_version_id as workspaceVersionId",
        "acceptance.scorecard",
        "acceptance.evaluated_at as evaluatedAt",
      ])
      .where("candidate.tenant_id", "=", tenantId)
      .where("candidate.orchestration_id", "=", orchestrationId)
      .orderBy("candidate.ordinal", "asc")
      .execute();
    const baseResource = parseCandidateRaceResource({
      orchestrationId: race.id,
      kind: race.kind,
      state: race.state,
      projectId: race.project_id,
      workspaceId: race.workspace_id,
      parentSessionId: race.parent_session_id,
      baseWorkspaceVersionId: race.base_workspace_version_id,
      prompt: race.prompt,
      maximumConcurrentCandidates: race.maximum_concurrent_candidates,
      acceptancePolicy: race.acceptance_policy,
      candidates: candidateRows.map((candidate) => ({
        candidateId: candidate.id,
        ordinal: candidate.ordinal,
        label: candidate.label,
        strategy: candidate.strategy,
        sessionId: candidate.child_session_id,
        runId: candidate.run_id,
        dispatchId: candidate.dispatchId,
        dispatchGeneration: candidate.dispatchGeneration,
        dispatchState: candidate.dispatchState,
        runState: candidate.runState,
        ...(candidate.workspaceVersionId === null
          ? {}
          : { workspaceVersionId: candidate.workspaceVersionId }),
        ...(candidate.verdict === null ||
        candidate.evaluatedAt === null ||
        candidate.scorecard === null
          ? {}
          : {
              acceptance: {
                verdict: candidate.verdict,
                ...(candidate.reviewBundleId === null
                  ? {}
                  : { reviewBundleId: candidate.reviewBundleId }),
                scorecard: candidate.scorecard,
                evaluatedAt: iso(candidate.evaluatedAt),
              },
            }),
        createdAt: iso(candidate.created_at),
      })),
      decisionGate: {
        gateId: race.gateId,
        state: race.gateState,
        ...(race.selectedCandidateId === null
          ? {}
          : { selectedCandidateId: race.selectedCandidateId }),
        ...(race.gateResolvedAt === null ? {} : { resolvedAt: iso(race.gateResolvedAt) }),
      },
      ...(race.winner_candidate_id === null ? {} : { winnerCandidateId: race.winner_candidate_id }),
      ...(race.promotedWorkspaceVersionId === null
        ? {}
        : { promotedWorkspaceVersionId: race.promotedWorkspaceVersionId }),
      ...(race.cancel_requested_at === null
        ? {}
        : { cancelRequestedAt: iso(race.cancel_requested_at) }),
      createdAt: iso(race.created_at),
      updatedAt: iso(race.updated_at),
      ...(race.settled_at === null ? {} : { settledAt: iso(race.settled_at) }),
    });
    const passing = baseResource.candidates
      .filter((candidate) => candidate.acceptance?.verdict === "passed")
      .sort((left, right) => {
        const leftMetrics = scorecardMetrics(left.acceptance!.scorecard);
        const rightMetrics = scorecardMetrics(right.acceptance!.scorecard);
        return (
          rightMetrics.tests.passed - leftMetrics.tests.passed ||
          leftMetrics.changedPaths - rightMetrics.changedPaths ||
          leftMetrics.costMicrousd - rightMetrics.costMicrousd ||
          leftMetrics.durationMs - rightMetrics.durationMs ||
          left.ordinal - right.ordinal
        );
      });
    return parseCandidateRaceResource({
      ...baseResource,
      ...(passing[0] === undefined ? {} : { recommendedCandidateId: passing[0].candidateId }),
    });
  }
}
