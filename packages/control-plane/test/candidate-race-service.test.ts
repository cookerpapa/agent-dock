import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  TURN_CANCELLATION_OUTBOX_TOPIC,
  type EnvironmentRuntimeSnapshot,
} from "@agent-dock/protocol";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CandidateRaceService,
  ControlPlaneStoreFactory,
  OutboxDispatcher,
  type TenantRequestIdentity,
  type TurnExecutionBackend,
} from "../src/index.ts";
import { createCompletedRunReviewBundle } from "../src/review-bundle.ts";

const IDS = {
  tenant: "71000000-0000-4000-8000-000000000001",
  user: "71000000-0000-4000-8000-000000000002",
  credential: "71000000-0000-4000-8000-000000000003",
  profile: "71000000-0000-4000-8000-000000000004",
  project: "71000000-0000-4000-8000-000000000005",
  workspace: "71000000-0000-4000-8000-000000000006",
  environment: "71000000-0000-4000-8000-000000000007",
  parentSession: "71000000-0000-4000-8000-000000000008",
  seedTurn: "71000000-0000-4000-8000-000000000009",
  seedCommand: "71000000-0000-4000-8000-00000000000a",
  seedRun: "71000000-0000-4000-8000-00000000000b",
  seedAttempt: "71000000-0000-4000-8000-00000000000c",
  seedPi: "71000000-0000-4000-8000-00000000000d",
  seedWorkspace: "71000000-0000-4000-8000-00000000000e",
  baseVersion: "71000000-0000-4000-8000-00000000000f",
} as const;

const identity: TenantRequestIdentity = {
  credentialId: "71000000-0000-4000-8000-000000000010",
  tenantId: IDS.tenant,
  tenantSlug: "candidate-race",
  userId: IDS.user,
  displayName: "Candidate Race Owner",
  role: "owner",
  defaultModelProfileId: IDS.profile,
};

const environment: EnvironmentRuntimeSnapshot = {
  environmentVersionId: IDS.environment,
  versionNumber: 1,
  profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  imageRevision: "candidate-race-test",
  specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};

let postgres: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let service: CandidateRaceService;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seed(): Promise<void> {
  const now = new Date("2026-07-23T00:00:00.000Z");
  await database
    .insertInto("tenants")
    .values({ id: IDS.tenant, slug: identity.tenantSlug })
    .execute();
  await database
    .insertInto("users")
    .values({ id: IDS.user, tenant_id: IDS.tenant, display_name: identity.displayName })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "agent-dock-fake",
      kind: "brokered",
      secret_ref: "test://candidate-race",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "candidate-race",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .execute();
  await database
    .insertInto("tenant_runtime_policies")
    .values({
      tenant_id: IDS.tenant,
      default_model_profile_id: IDS.profile,
      maximum_projects: 10,
      maximum_sessions: 30,
      maximum_unsettled_turns: 20,
      maximum_concurrent_turns: 4,
    })
    .execute();
  await database
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "Candidate Race" })
    .execute();
  await database
    .insertInto("workspaces")
    .values({ id: IDS.workspace, tenant_id: IDS.tenant, project_id: IDS.project })
    .execute();
  await database
    .insertInto("workspace_sources")
    .values({
      tenant_id: IDS.tenant,
      workspace_id: IDS.workspace,
      kind: "sample_java",
      repository: null,
      commit_sha: null,
      github_installation_id: null,
      github_repository_id: null,
      status: "ready",
      object_key: null,
      sha256: null,
      size_bytes: null,
      import_lease_id: null,
      lease_expires_at: null,
      failure_code: null,
    })
    .execute();
  await database
    .insertInto("environment_versions")
    .values({
      id: IDS.environment,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      version_number: 1,
      profile_key: environment.profileKey,
      profile_version: environment.profileVersion,
      image_revision: environment.imageRevision,
      spec_sha256: environment.specSha256,
      recipe: environment.recipe,
      recipe_sha256: environment.recipeSha256,
      state: "validated",
      active: true,
      created_by_user_id: IDS.user,
      failure_code: null,
      validated_at: now,
    })
    .execute();
  await database
    .insertInto("sessions")
    .values({
      id: IDS.parentSession,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: IDS.profile,
      state: "idle",
      pi_session_snapshot_key: null,
      workspace_snapshot_key: null,
    })
    .execute();
  await database
    .insertInto("session_event_cursors")
    .values({ session_id: IDS.parentSession })
    .execute();
  await database
    .insertInto("turns")
    .values({
      id: IDS.seedTurn,
      tenant_id: IDS.tenant,
      session_id: IDS.parentSession,
      state: "completed",
      input_kind: "prompt",
      input_text: "Create the immutable baseline",
      model_profile_id: IDS.profile,
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      thinking_level: "off",
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      stop_reason: "stop",
      failure_code: null,
      failure_message: null,
      failure_retryable: null,
      started_at: new Date(now.valueOf() - 1_000),
      settled_at: now,
    })
    .execute();
  await database
    .insertInto("commands")
    .values({
      id: IDS.seedCommand,
      tenant_id: IDS.tenant,
      session_id: IDS.parentSession,
      turn_id: IDS.seedTurn,
      idempotency_key: "seed",
      kind: "turn.execute",
      state: "completed",
      mailbox_position: 1,
      payload: { schemaVersion: 1, requestHash: "a".repeat(64) },
      dispatched_at: new Date(now.valueOf() - 1_000),
      acknowledged_at: new Date(now.valueOf() - 900),
      completed_at: now,
      failure_code: null,
    })
    .execute();
  await database
    .insertInto("runs")
    .values({
      id: IDS.seedRun,
      trace_id: "1".repeat(32),
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      session_id: IDS.parentSession,
      turn_id: IDS.seedTurn,
      command_id: IDS.seedCommand,
      environment_version_id: IDS.environment,
      source_set_snapshot: {
        schemaVersion: 1,
        entries: [{ root: ".", kind: "sample_java" }],
      },
      conversation_base_seq: 0,
      workspace_base_version_id: null,
      pi_session_base_artifact_id: null,
      idempotency_key: "seed",
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
    .execute();
  await database
    .insertInto("run_attempts")
    .values({
      id: IDS.seedAttempt,
      tenant_id: IDS.tenant,
      run_id: IDS.seedRun,
      attempt_number: 1,
      state: "completed",
      claim_owner_id: "seed-worker",
      claim_expires_at: new Date(now.valueOf() + 60_000),
      sandbox_id: null,
      lease_id: null,
      fencing_token: null,
      checkpoint_revision: sha256("seed-workspace"),
      failure_code: null,
      failure_message: null,
      failure_retryable: null,
      provisioning_at: null,
      restoring_at: null,
      running_at: new Date(now.valueOf() - 1_000),
      checkpointing_at: new Date(now.valueOf() - 100),
      last_heartbeat_at: now,
      settled_at: now,
      claimed_at: new Date(now.valueOf() - 1_100),
    })
    .execute();
  await database
    .updateTable("runs")
    .set({
      state: "completed",
      current_attempt_id: IDS.seedAttempt,
      attempt_count: 1,
      stop_reason: "stop",
      started_at: new Date(now.valueOf() - 1_000),
      settled_at: now,
    })
    .where("id", "=", IDS.seedRun)
    .execute();
  await database
    .insertInto("artifacts")
    .values([
      {
        id: IDS.seedPi,
        tenant_id: IDS.tenant,
        session_id: IDS.parentSession,
        turn_id: IDS.seedTurn,
        run_id: IDS.seedRun,
        kind: "pi_session_snapshot",
        object_key: "candidate-race/pi/base",
        sha256: sha256("seed-pi"),
        size_bytes: 7,
        file_name: "session.jsonl",
        media_type: "application/jsonl",
      },
      {
        id: IDS.seedWorkspace,
        tenant_id: IDS.tenant,
        session_id: IDS.parentSession,
        turn_id: IDS.seedTurn,
        run_id: IDS.seedRun,
        kind: "workspace_snapshot",
        object_key: "candidate-race/workspace/base",
        sha256: sha256("seed-workspace"),
        size_bytes: 14,
        file_name: "workspace.snapshot",
        media_type: "application/octet-stream",
      },
    ])
    .execute();
  await database
    .insertInto("workspace_versions")
    .values({
      id: IDS.baseVersion,
      tenant_id: IDS.tenant,
      workspace_id: IDS.workspace,
      session_id: IDS.parentSession,
      version_number: 1,
      parent_version_id: null,
      source_version_id: null,
      origin_kind: "checkpoint",
      run_id: IDS.seedRun,
      attempt_id: IDS.seedAttempt,
      turn_id: IDS.seedTurn,
      pi_artifact_id: IDS.seedPi,
      workspace_artifact_id: IDS.seedWorkspace,
      patch_artifact_id: null,
      revision: sha256("seed-workspace"),
      file_count: 1,
      state: "settled",
      settled_at: now,
    })
    .execute();
  await database
    .updateTable("sessions")
    .set({
      current_workspace_version_id: IDS.baseVersion,
      pi_session_snapshot_key: "candidate-race/pi/base",
      workspace_snapshot_key: "candidate-race/workspace/base",
      next_mailbox_position: 2,
    })
    .where("id", "=", IDS.parentSession)
    .execute();
}

async function settlePassingCandidate(
  candidate: {
    candidateId: string;
    sessionId: string;
    runId: string;
    ordinal: number;
  },
  passedTests: number,
  changedPaths: number,
  initialFailure = false,
): Promise<void> {
  const run = await database
    .selectFrom("runs")
    .select(["turn_id", "command_id", "workspace_base_version_id", "queued_at"])
    .where("id", "=", candidate.runId)
    .executeTakeFirstOrThrow();
  const attemptId = randomUUID();
  const piArtifactId = randomUUID();
  const workspaceArtifactId = randomUUID();
  const patchArtifactId = randomUUID();
  const workspaceVersionId = randomUUID();
  const leaseId = randomUUID();
  const startedAt = new Date(new Date(run.queued_at).valueOf() + 100);
  const settledAt = new Date(startedAt.valueOf() + candidate.ordinal * 1_000);
  const patch = Array.from(
    { length: changedPaths },
    (_, index) =>
      `diff --git a/src/result-${String(index)}.txt b/src/result-${String(index)}.txt\n` +
      `--- /dev/null\n+++ b/src/result-${String(index)}.txt\n@@ -0,0 +1 @@\n+candidate ${String(candidate.ordinal)}\n`,
  ).join("");

  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("run_attempts")
      .values({
        id: attemptId,
        tenant_id: IDS.tenant,
        run_id: candidate.runId,
        attempt_number: 1,
        state: "completed",
        claim_owner_id: "candidate-test-worker",
        claim_expires_at: new Date(settledAt.valueOf() + 60_000),
        sandbox_id: null,
        lease_id: null,
        fencing_token: null,
        checkpoint_revision: sha256(`workspace-${candidate.candidateId}`),
        failure_code: null,
        failure_message: null,
        failure_retryable: null,
        provisioning_at: startedAt,
        restoring_at: startedAt,
        running_at: startedAt,
        checkpointing_at: settledAt,
        last_heartbeat_at: settledAt,
        settled_at: settledAt,
        claimed_at: startedAt,
      })
      .execute();
    await transaction
      .updateTable("runs")
      .set({
        state: "completed",
        current_attempt_id: attemptId,
        attempt_count: 1,
        stop_reason: "stop",
        started_at: startedAt,
        settled_at: settledAt,
      })
      .where("id", "=", candidate.runId)
      .execute();
    await transaction
      .updateTable("turns")
      .set({
        state: "completed",
        stop_reason: "stop",
        started_at: startedAt,
        settled_at: settledAt,
      })
      .where("id", "=", run.turn_id)
      .execute();
    await transaction
      .updateTable("commands")
      .set({
        state: "completed",
        dispatched_at: startedAt,
        acknowledged_at: startedAt,
        completed_at: settledAt,
      })
      .where("id", "=", run.command_id)
      .execute();
    await transaction
      .updateTable("outbox")
      .set({ published_at: settledAt })
      .where("tenant_id", "=", IDS.tenant)
      .where("aggregate_id", "=", candidate.sessionId)
      .execute();
    await transaction
      .insertInto("artifacts")
      .values([
        {
          id: piArtifactId,
          tenant_id: IDS.tenant,
          session_id: candidate.sessionId,
          turn_id: run.turn_id,
          run_id: candidate.runId,
          kind: "pi_session_snapshot",
          object_key: `candidate-race/pi/${candidate.candidateId}`,
          sha256: sha256(`pi-${candidate.candidateId}`),
          size_bytes: 16,
          file_name: "session.jsonl",
          media_type: "application/jsonl",
        },
        {
          id: workspaceArtifactId,
          tenant_id: IDS.tenant,
          session_id: candidate.sessionId,
          turn_id: run.turn_id,
          run_id: candidate.runId,
          kind: "workspace_snapshot",
          object_key: `candidate-race/workspace/${candidate.candidateId}`,
          sha256: sha256(`workspace-${candidate.candidateId}`),
          size_bytes: 32,
          file_name: "workspace.snapshot",
          media_type: "application/octet-stream",
        },
        {
          id: patchArtifactId,
          tenant_id: IDS.tenant,
          session_id: candidate.sessionId,
          turn_id: run.turn_id,
          run_id: candidate.runId,
          kind: "patch",
          object_key: `candidate-race/patch/${candidate.candidateId}`,
          sha256: sha256(patch),
          size_bytes: Buffer.byteLength(patch),
          file_name: "changes.patch",
          media_type: "text/x-diff",
        },
      ])
      .execute();
    await transaction
      .insertInto("workspace_versions")
      .values({
        id: workspaceVersionId,
        tenant_id: IDS.tenant,
        workspace_id: IDS.workspace,
        session_id: candidate.sessionId,
        version_number: 2,
        parent_version_id: run.workspace_base_version_id,
        source_version_id: null,
        origin_kind: "checkpoint",
        run_id: candidate.runId,
        attempt_id: attemptId,
        turn_id: run.turn_id,
        pi_artifact_id: piArtifactId,
        workspace_artifact_id: workspaceArtifactId,
        patch_artifact_id: patchArtifactId,
        revision: sha256(`workspace-${candidate.candidateId}`),
        file_count: changedPaths,
        state: "settled",
        settled_at: settledAt,
      })
      .execute();
    await transaction
      .updateTable("sessions")
      .set({
        state: "idle",
        current_workspace_version_id: workspaceVersionId,
        pi_session_snapshot_key: `candidate-race/pi/${candidate.candidateId}`,
        workspace_snapshot_key: `candidate-race/workspace/${candidate.candidateId}`,
        last_active_at: settledAt,
      })
      .where("id", "=", candidate.sessionId)
      .execute();
    await transaction
      .insertInto("session_events")
      .values([
        {
          event_id: randomUUID(),
          tenant_id: IDS.tenant,
          session_id: candidate.sessionId,
          turn_id: run.turn_id,
          agent_node_id: null,
          agent_id: "root",
          command_id: run.command_id,
          seq: 1,
          schema_version: 1,
          type: "assistant.text.delta",
          payload: { text: `Candidate ${String(candidate.ordinal)} completed.` },
          lease_id: leaseId,
          fencing_token: 1,
          occurred_at: startedAt,
        },
        {
          event_id: randomUUID(),
          tenant_id: IDS.tenant,
          session_id: candidate.sessionId,
          turn_id: run.turn_id,
          agent_node_id: null,
          agent_id: "root",
          command_id: run.command_id,
          seq: 2,
          schema_version: 1,
          type: "turn.completed",
          payload: {
            stopReason: "stop",
            workspacePatch: { patch, truncated: false },
          },
          lease_id: leaseId,
          fencing_token: 1,
          occurred_at: settledAt,
        },
      ])
      .execute();
    await transaction
      .insertInto("test_results")
      .values([
        ...(initialFailure
          ? [
              {
                id: randomUUID(),
                tenant_id: IDS.tenant,
                session_id: candidate.sessionId,
                turn_id: run.turn_id,
                run_id: candidate.runId,
                workspace_version_id: workspaceVersionId,
                tool_call_id: "test-initial-red",
                command: `./test-candidate-${String(candidate.ordinal)}.sh case 1`,
                suite: `candidate-${String(candidate.ordinal)}`,
                status: "failed" as const,
                exit_code: 1,
                duration_ms: 25,
                summary: "failed before repair",
                artifact_id: null,
                created_at: new Date(startedAt.valueOf() + 100),
              },
            ]
          : []),
        ...Array.from({ length: passedTests }, (_, index) => ({
          id: randomUUID(),
          tenant_id: IDS.tenant,
          session_id: candidate.sessionId,
          turn_id: run.turn_id,
          run_id: candidate.runId,
          workspace_version_id: workspaceVersionId,
          tool_call_id: `test-${String(index + 1)}`,
          command: `./test-candidate-${String(candidate.ordinal)}.sh case ${String(index + 1)}`,
          suite: `candidate-${String(candidate.ordinal)}`,
          status: "passed" as const,
          exit_code: 0,
          duration_ms: 25,
          summary: "passed",
          artifact_id: null,
          created_at: new Date(startedAt.valueOf() + 200 + index),
        })),
      ])
      .execute();
    await createCompletedRunReviewBundle(
      transaction,
      {
        tenantId: IDS.tenant,
        projectId: IDS.project,
        workspaceId: IDS.workspace,
        sessionId: candidate.sessionId,
        runId: candidate.runId,
        turnId: run.turn_id,
        attemptId,
        environment,
      },
      "stop",
      settledAt,
    );
  });
}

beforeAll(async () => {
  postgres = await PGlite.create();
  socket = new PGLiteSocketServer({ db: postgres, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await seed();
  const factory = new ControlPlaneStoreFactory({ database });
  service = new CandidateRaceService({ database, controlPlaneStores: factory });
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await postgres?.close();
});

describe.sequential("candidate race orchestration", () => {
  it("fans out atomically, replays idempotently, and cancels all queued candidates", async () => {
    const request = {
      baseWorkspaceVersionId: IDS.baseVersion,
      prompt: "Implement a bounded repair and run tests.",
      candidates: [
        { label: "Minimal", strategy: "Keep the patch small." },
        { label: "Tests first", strategy: "Write tests before the implementation." },
        { label: "Defensive", strategy: "Handle adjacent edge cases." },
      ],
      maximumConcurrentCandidates: 2,
      acceptance: {
        requirePatch: true,
        requireTests: true,
        maximumChangedPaths: 20,
        protectedPathPrefixes: [],
      },
    };
    const created = await service.create(identity, IDS.parentSession, "cancel-race", request);
    expect(created).toMatchObject({
      state: "running",
      parentSessionId: IDS.parentSession,
      baseWorkspaceVersionId: IDS.baseVersion,
      maximumConcurrentCandidates: 2,
    });
    expect(new Set(created.candidates.map((candidate) => candidate.sessionId)).size).toBe(3);
    expect(new Set(created.candidates.map((candidate) => candidate.runId)).size).toBe(3);
    await expect(
      service.create(identity, IDS.parentSession, "cancel-race", request),
    ).resolves.toMatchObject({ orchestrationId: created.orchestrationId });
    await expect(
      service.create(identity, IDS.parentSession, "cancel-race", {
        ...request,
        prompt: "Different prompt",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const cancelled = await service.cancel(identity, created.orchestrationId, "cancel-all");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.candidates.every((candidate) => candidate.runState === "cancelled")).toBe(
      true,
    );
    expect(cancelled.candidates.every((candidate) => candidate.dispatchState === "cancelled")).toBe(
      true,
    );
  });

  it("admits no more active candidates than the race-level concurrency cap", async () => {
    const race = await service.create(identity, IDS.parentSession, "scheduler-race", {
      baseWorkspaceVersionId: IDS.baseVersion,
      prompt: "Try two independent implementations.",
      candidates: [
        { label: "One", strategy: "Use approach one." },
        { label: "Two", strategy: "Use approach two." },
      ],
      maximumConcurrentCandidates: 1,
      acceptance: {
        requirePatch: true,
        requireTests: true,
        maximumChangedPaths: 10,
        protectedPathPrefixes: [],
      },
    });
    let announceEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      announceEntered = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let executions = 0;
    const backend: TurnExecutionBackend = {
      async execute(_request, lifecycle) {
        executions += 1;
        await lifecycle.started();
        if (executions === 1) {
          announceEntered();
          await release;
        }
        return { stopReason: "scheduler-test" };
      },
    };
    const activeLane = new OutboxDispatcher({ database, backend });
    const probeLane = new OutboxDispatcher({ database, backend });
    const first = activeLane.dispatchNext();
    await entered;
    await expect(probeLane.dispatchNext()).resolves.toEqual({ status: "idle" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(probeLane.dispatchNext()).resolves.toMatchObject({ status: "completed" });
    expect(executions).toBe(2);
    await expect(service.get(identity, race.orchestrationId)).resolves.toMatchObject({
      state: "failed",
      candidates: [{ acceptance: { verdict: "failed" } }, { acceptance: { verdict: "failed" } }],
    });
  });

  it("bridges a cancellation that races with command acknowledgement into the durable cancel lane", async () => {
    const race = await service.create(identity, IDS.parentSession, "dispatch-cancel-race", {
      baseWorkspaceVersionId: IDS.baseVersion,
      prompt: "Keep one candidate dispatching while the race is cancelled.",
      candidates: [
        { label: "One", strategy: "Use approach one." },
        { label: "Two", strategy: "Use approach two." },
      ],
      maximumConcurrentCandidates: 1,
      acceptance: {
        requirePatch: false,
        requireTests: false,
        maximumChangedPaths: 10,
        protectedPathPrefixes: [],
      },
    });
    let announceClaimed!: () => void;
    let allowAcknowledgement!: () => void;
    let announceAcknowledged!: () => void;
    let allowCompletion!: () => void;
    const claimed = new Promise<void>((resolvePromise) => {
      announceClaimed = resolvePromise;
    });
    const acknowledge = new Promise<void>((resolvePromise) => {
      allowAcknowledgement = resolvePromise;
    });
    const acknowledged = new Promise<void>((resolvePromise) => {
      announceAcknowledged = resolvePromise;
    });
    const complete = new Promise<void>((resolvePromise) => {
      allowCompletion = resolvePromise;
    });
    let claimedSessionId: string | undefined;
    const backend: TurnExecutionBackend = {
      async execute(request, lifecycle) {
        claimedSessionId = request.sessionId;
        announceClaimed();
        await acknowledge;
        await lifecycle.started();
        announceAcknowledged();
        await complete;
        return { stopReason: "dispatch-cancel-test" };
      },
    };
    const dispatcher = new OutboxDispatcher({ database, backend });
    const execution = dispatcher.dispatchNext();
    await claimed;

    await expect(
      service.cancel(identity, race.orchestrationId, "cancel-while-dispatching"),
    ).resolves.toMatchObject({ state: "cancel_requested" });
    allowAcknowledgement();
    await acknowledged;
    const claimedCandidate = race.candidates.find(
      (candidate) => candidate.sessionId === claimedSessionId,
    );
    expect(claimedCandidate).toBeDefined();

    const cancellation = await database
      .selectFrom("commands as command")
      .innerJoin("outbox", (join) =>
        join
          .onRef("outbox.tenant_id", "=", "command.tenant_id")
          .on(
            sql<boolean>`${sql.ref("outbox.payload")} ->> 'commandId' = ${sql.ref("command.id")}::text`,
          ),
      )
      .select(["command.state", "command.idempotency_key", "outbox.topic", "outbox.published_at"])
      .where("command.tenant_id", "=", IDS.tenant)
      .where("command.session_id", "=", claimedCandidate!.sessionId)
      .where("command.kind", "=", "turn.cancel")
      .executeTakeFirstOrThrow();
    expect(cancellation).toEqual({
      state: "pending",
      idempotency_key: `race-cancel:${race.orchestrationId}:${claimedCandidate!.candidateId}`,
      topic: TURN_CANCELLATION_OUTBOX_TOPIC,
      published_at: null,
    });

    allowCompletion();
    await expect(execution).resolves.toMatchObject({ status: "completed" });
  });

  it("evaluates immutable Review Bundles, recommends deterministically, and CAS-promotes a winner", async () => {
    const race = await service.create(identity, IDS.parentSession, "promotion-race", {
      baseWorkspaceVersionId: IDS.baseVersion,
      prompt: "Implement the selected behavior and prove it with tests.",
      candidates: [
        { label: "Small", strategy: "Use one path and two tests." },
        { label: "Thorough", strategy: "Use two paths and three tests." },
      ],
      maximumConcurrentCandidates: 2,
      acceptance: {
        requirePatch: true,
        requireTests: true,
        maximumChangedPaths: 10,
        protectedPathPrefixes: [],
      },
    });
    await settlePassingCandidate(race.candidates[0]!, 2, 1, true);
    await settlePassingCandidate(race.candidates[1]!, 3, 2);

    const evaluated = await service.get(identity, race.orchestrationId);
    expect(evaluated.state).toBe("awaiting_decision");
    expect(evaluated.candidates.map((candidate) => candidate.acceptance?.verdict)).toEqual([
      "passed",
      "passed",
    ]);
    expect(evaluated.candidates[0]?.acceptance?.scorecard.metrics.tests).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      errored: 0,
    });
    const redGreenBundle = await new ControlPlaneStoreFactory({ database })
      .forIdentity(identity)
      .getReviewBundle(evaluated.candidates[0]!.runId);
    expect(redGreenBundle.manifest.tests.map((test) => test.status)).toEqual([
      "failed",
      "passed",
      "passed",
    ]);
    expect(evaluated.recommendedCandidateId).toBe(evaluated.candidates[1]!.candidateId);

    const promoted = await service.promote(identity, race.orchestrationId, "promote-thorough", {
      candidateId: evaluated.candidates[1]!.candidateId,
      expectedParentWorkspaceVersionId: IDS.baseVersion,
    });
    expect(promoted).toMatchObject({
      state: "completed",
      winnerCandidateId: evaluated.candidates[1]!.candidateId,
      decisionGate: {
        state: "resolved",
        selectedCandidateId: evaluated.candidates[1]!.candidateId,
      },
    });
    const parent = await database
      .selectFrom("sessions")
      .select(["current_workspace_version_id", "pi_session_snapshot_key"])
      .where("id", "=", IDS.parentSession)
      .executeTakeFirstOrThrow();
    const promotedVersion = await database
      .selectFrom("workspace_versions")
      .select(["origin_kind", "source_version_id", "pi_artifact_id"])
      .where("id", "=", parent.current_workspace_version_id!)
      .executeTakeFirstOrThrow();
    expect(promotedVersion).toEqual({
      origin_kind: "promotion",
      source_version_id: evaluated.candidates[1]!.workspaceVersionId,
      pi_artifact_id: IDS.seedPi,
    });
    expect(parent.pi_session_snapshot_key).toBe("candidate-race/pi/base");
    await expect(
      service.promote(identity, race.orchestrationId, "different-promotion", {
        candidateId: evaluated.candidates[0]!.candidateId,
        expectedParentWorkspaceVersionId: IDS.baseVersion,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
