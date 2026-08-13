import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { createAgentDockEventFactory, type EventPublishMessage } from "@agent-dock/protocol";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrivateTenant,
  DurableEventStore,
  ModelGovernanceService,
  type TenantRequestIdentity,
} from "../src/index.ts";

const IDS = {
  project: "10000000-0000-4000-8000-000000000001",
  workspace: "20000000-0000-4000-8000-000000000001",
  session: "30000000-0000-4000-8000-000000000001",
  turn: "40000000-0000-4000-8000-000000000001",
  command: "50000000-0000-4000-8000-000000000001",
  run: "60000000-0000-4000-8000-000000000001",
  attempt: "70000000-0000-4000-8000-000000000001",
  sandbox: "80000000-0000-4000-8000-000000000001",
  boot: "90000000-0000-4000-8000-000000000001",
  lease: "a0000000-0000-4000-8000-000000000001",
  startEvent: "b0000000-0000-4000-8000-000000000001",
  endEvent: "c0000000-0000-4000-8000-000000000001",
  startMessage: "d0000000-0000-4000-8000-000000000001",
  endMessage: "e0000000-0000-4000-8000-000000000001",
  environment: "f0000000-0000-4000-8000-000000000001",
} as const;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let owner: TenantRequestIdentity;
let otherOwner: TenantRequestIdentity;
let service: ModelGovernanceService;

function identity(tenant: Awaited<ReturnType<typeof createPrivateTenant>>): TenantRequestIdentity {
  return {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: "Owner",
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  const first = await createPrivateTenant(database, {
    slug: "context-owner",
    ownerDisplayName: "Context Owner",
  });
  const second = await createPrivateTenant(database, {
    slug: "context-other",
    ownerDisplayName: "Other Owner",
  });
  owner = identity(first);
  otherOwner = identity(second);
  service = new ModelGovernanceService({ database });

  const now = new Date();
  await database
    .insertInto("projects")
    .values({
      id: IDS.project,
      tenant_id: owner.tenantId,
      name: "Context audit",
      created_at: now,
      updated_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: owner.tenantId,
      project_id: IDS.project,
      sandbox_domain_id: "sandbox-domain-0001",
      object_snapshot_key: null,
      created_at: now,
      updated_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("environment_versions")
    .values({
      id: IDS.environment,
      tenant_id: owner.tenantId,
      project_id: IDS.project,
      version_number: 1,
      profile_key: "agent-dock-fullstack",
      profile_version: "1",
      image_revision: "development",
      spec_sha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      state: "pending",
      active: true,
      validated_at: null,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sessions")
    .values({
      id: IDS.session,
      tenant_id: owner.tenantId,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: owner.defaultModelProfileId,
      state: "running",
      last_fencing_token: 1,
      created_at: now,
      updated_at: now,
      last_active_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("session_event_cursors")
    .values({ session_id: IDS.session })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("turns")
    .values({
      id: IDS.turn,
      tenant_id: owner.tenantId,
      session_id: IDS.session,
      state: "running",
      input_kind: "prompt",
      input_text: "Compact this context",
      model_profile_id: owner.defaultModelProfileId,
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      thinking_level: "off",
      credential_binding_id: first.credentialBindingId,
      credential_binding_version: 1,
      started_at: now,
      created_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("commands")
    .values({
      id: IDS.command,
      tenant_id: owner.tenantId,
      session_id: IDS.session,
      turn_id: IDS.turn,
      idempotency_key: "context-audit",
      kind: "turn.execute",
      state: "acknowledged",
      mailbox_position: 1,
      payload: {},
      created_at: now,
      dispatched_at: now,
      acknowledged_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("runs")
    .values({
      id: IDS.run,
      tenant_id: owner.tenantId,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      session_id: IDS.session,
      turn_id: IDS.turn,
      command_id: IDS.command,
      environment_version_id: IDS.environment,
      idempotency_key: "context-audit",
      state: "queued",
      current_attempt_id: null,
      attempt_count: 0,
      queued_at: now,
      created_at: now,
      updated_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sandboxes")
    .values({
      id: IDS.sandbox,
      supervisor_id: "context-supervisor",
      boot_id: IDS.boot,
      state: "leased",
      max_concurrent_sessions: 1,
      active_sessions: 1,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("run_attempts")
    .values({
      id: IDS.attempt,
      tenant_id: owner.tenantId,
      run_id: IDS.run,
      attempt_number: 1,
      state: "running",
      claim_owner_id: "context-test",
      claim_expires_at: new Date(now.valueOf() + 120_000),
      sandbox_id: IDS.sandbox,
      lease_id: IDS.lease,
      fencing_token: 1,
      claimed_at: now,
      running_at: now,
      created_at: now,
      updated_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .updateTable("runs")
    .set({
      state: "running",
      current_attempt_id: IDS.attempt,
      attempt_count: 1,
      started_at: now,
      updated_at: now,
    })
    .where("id", "=", IDS.run)
    .executeTakeFirstOrThrow();
  await database
    .insertInto("session_leases")
    .values({
      session_id: IDS.session,
      lease_id: IDS.lease,
      sandbox_id: IDS.sandbox,
      fencing_token: 1,
      valid_until: new Date(now.valueOf() + 120_000),
      acquired_at: now,
      renewed_at: now,
    })
    .executeTakeFirstOrThrow();
});

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("model governance and context audit", () => {
  it("persists native Pi compaction boundaries and exposes only summary metadata", async () => {
    let index = 0;
    const eventIds = [IDS.startEvent, IDS.endEvent];
    const messages = [IDS.startMessage, IDS.endMessage];
    const factory = createAgentDockEventFactory(
      { sessionId: IDS.session, turnId: IDS.turn, agentId: "root" },
      { idGenerator: () => eventIds[index++]! },
    );
    const eventStore = new DurableEventStore({ database });
    for (const body of [
      { type: "context.compaction.started" as const, payload: { reason: "threshold" as const } },
      {
        type: "context.compaction.completed" as const,
        payload: {
          reason: "threshold" as const,
          status: "completed" as const,
          willRetry: false,
          tokensBefore: 80_000,
          estimatedTokensAfter: 18_000,
          summarySha256: "a".repeat(64),
          summaryVersion: 1,
        },
      },
    ]) {
      const event = factory.next(body);
      const message: EventPublishMessage = {
        protocolVersion: 1,
        messageId: messages[event.seq - 1]!,
        sentAt: new Date().toISOString(),
        type: "event.publish",
        payload: {
          leaseId: IDS.lease,
          fencingToken: 1,
          commandId: IDS.command,
          event,
        },
      };
      await eventStore.ingest(message);
    }
    const context = await service.sessionContext(owner, IDS.session);
    expect(context.history).toEqual([
      expect.objectContaining({
        compactionId: IDS.startEvent,
        state: "completed",
        tokensBefore: 80_000,
        estimatedTokensAfter: 18_000,
        summarySha256: "a".repeat(64),
        summaryVersion: 1,
      }),
    ]);
    expect(JSON.stringify(context)).not.toContain('summary":');
  });

  it("enforces tenant and owner boundaries", async () => {
    await expect(service.sessionContext(otherOwner, IDS.session)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.runUsage(otherOwner, IDS.run)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.replace(
        { ...owner, role: "viewer" },
        {
          limits: {
            maximumModelRequestsPerRun: 32,
            maximumCostMicrousdPerRun: 5_000_000,
            dailyTokenBudget: 2_000_000,
            monthlyCostMicrousdBudget: 50_000_000,
            maximumToolCallsPerRun: 128,
            maximumToolOutputBytes: 65_536,
            maximumRunDurationMs: 900_000,
            compactionReserveTokens: 16_384,
            compactionKeepRecentTokens: 20_000,
          },
          rates: [
            {
              provider: "deepseek",
              modelId: "deepseek-v4-flash",
              inputMicrousdPerMillion: 0,
              outputMicrousdPerMillion: 0,
              cacheReadMicrousdPerMillion: 0,
              cacheWriteMicrousdPerMillion: 0,
            },
          ],
          fallback: {
            enabled: false,
            onRateLimit: true,
            onServerError: true,
            onTimeout: true,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });
});
