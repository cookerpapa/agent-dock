import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  PostgresTenantModelCredentialResolver,
  TenantModelConfigurationService,
  TenantModelCredentialVault,
  createPrivateTenant,
  type TenantRequestIdentity,
} from "@pi-cloud/control-plane";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  modelSamplingHeaders,
  type ExecuteTurnCommandMessage,
} from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantModelGateway } from "../src/index.ts";

const IDS = {
  project: "10000000-0000-4000-8000-000000000001",
  workspace: "20000000-0000-4000-8000-000000000001",
  session: "30000000-0000-4000-8000-000000000001",
  turn: "40000000-0000-4000-8000-000000000001",
  command: "50000000-0000-4000-8000-000000000001",
  message: "60000000-0000-4000-8000-000000000001",
  lease: "70000000-0000-4000-8000-000000000001",
  environment: "80000000-0000-4000-8000-000000000001",
} as const;
const PROVIDER_SECRET = `sk-${"p".repeat(48)}`;
const MASTER_KEY = Buffer.alloc(32, 21).toString("base64url");
let samplingStepSequence = 0;
function nextSamplingHeaders(): Record<string, string> {
  samplingStepSequence += 1;
  return modelSamplingHeaders({
    stepSequence: samplingStepSequence,
    stepSha256: samplingStepSequence.toString(16).padStart(64, "0"),
    samplingAttempt: 1,
  });
}

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let command: ExecuteTurnCommandMessage;
let gateway: TenantModelGateway;
let upstreamFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: "gateway-tenant",
    ownerDisplayName: "Gateway Owner",
  });
  const identity: TenantRequestIdentity = {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: "Gateway Owner",
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
  const vault = new TenantModelCredentialVault(MASTER_KEY);
  await new TenantModelConfigurationService({ database, vault }).replace(identity, {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    apiKey: PROVIDER_SECRET,
  });
  await database
    .updateTable("model_rates")
    .set({
      input_microusd_per_million: 1_000_000,
      output_microusd_per_million: 2_000_000,
      cache_read_microusd_per_million: 500_000,
      cache_write_microusd_per_million: 3_000_000,
    })
    .where("tenant_id", "=", tenant.tenantId)
    .where("provider", "=", "deepseek")
    .where("model_id", "=", "deepseek-v4-flash")
    .executeTakeFirstOrThrow();
  const now = new Date("2026-07-19T15:00:00.000Z");
  await database
    .insertInto("projects")
    .values({
      id: IDS.project,
      tenant_id: tenant.tenantId,
      name: "Gateway fixture",
      created_at: now,
      updated_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: tenant.tenantId,
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
      tenant_id: tenant.tenantId,
      project_id: IDS.project,
      version_number: 1,
      profile_key: "pi-cloud-fullstack",
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
      tenant_id: tenant.tenantId,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: tenant.defaultModelProfileId,
      state: "running",
      created_at: now,
      updated_at: now,
      last_active_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("turns")
    .values({
      id: IDS.turn,
      tenant_id: tenant.tenantId,
      session_id: IDS.session,
      state: "running",
      input_kind: "prompt",
      input_text: "Repair it",
      model_profile_id: tenant.defaultModelProfileId,
      provider: "deepseek",
      model_id: "deepseek-v4-flash",
      thinking_level: "off",
      credential_binding_id: tenant.credentialBindingId,
      credential_binding_version: 2,
      started_at: now,
      created_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("commands")
    .values({
      id: IDS.command,
      tenant_id: tenant.tenantId,
      session_id: IDS.session,
      turn_id: IDS.turn,
      idempotency_key: "gateway-live-1",
      kind: "turn.execute",
      state: "acknowledged",
      mailbox_position: 1,
      payload: {},
      created_at: now,
      dispatched_at: now,
      acknowledged_at: now,
    })
    .executeTakeFirstOrThrow();
  const runId = "60000000-0000-4000-8000-000000000001";
  const attemptId = "70000000-0000-4000-8000-000000000001";
  await database
    .insertInto("runs")
    .values({
      id: runId,
      tenant_id: tenant.tenantId,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      session_id: IDS.session,
      turn_id: IDS.turn,
      command_id: IDS.command,
      environment_version_id: IDS.environment,
      idempotency_key: "gateway-live-1",
      state: "queued",
      current_attempt_id: null,
      attempt_count: 0,
      queued_at: now,
      created_at: now,
      updated_at: now,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("run_attempts")
    .values({
      id: attemptId,
      tenant_id: tenant.tenantId,
      run_id: runId,
      attempt_number: 1,
      state: "running",
      claim_owner_id: "gateway-test",
      claim_expires_at: new Date(now.valueOf() + 60_000),
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
      current_attempt_id: attemptId,
      attempt_count: 1,
      started_at: now,
      updated_at: now,
    })
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  command = {
    protocolVersion: 1,
    messageId: IDS.message,
    sentAt: now.toISOString(),
    type: "command.turn.execute",
    payload: {
      commandId: IDS.command,
      idempotencyKey: "gateway-live-1",
      tenantId: tenant.tenantId,
      projectId: IDS.project,
      workspaceId: IDS.workspace,
      sessionId: IDS.session,
      runId,
      turnId: IDS.turn,
      attemptId,
      agentId: "root",
      leaseId: IDS.lease,
      fencingToken: 1,
      nextEventSeq: 1,
      input: { kind: "prompt", text: "Repair it" },
      sandboxRetention: "ephemeral",
      model: {
        profileId: tenant.defaultModelProfileId,
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        thinkingLevel: "off",
        credentialBindingId: tenant.credentialBindingId,
        credentialBindingVersion: 2,
      },
      environment: {
        environmentVersionId: IDS.environment,
        versionNumber: 1,
        profileKey: "pi-cloud-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
    },
  };
  upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${PROVIDER_SECRET}`);
    const upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(upstreamBody).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      stream_options: { include_usage: true },
    });
    return new Response(
      [
        'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-test","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_cache_hit_tokens":2}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  gateway = new TenantModelGateway({
    database,
    credentialResolver: new PostgresTenantModelCredentialResolver({ database, vault }),
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://supervisor-host:4200",
    fetchImplementation: upstreamFetch,
  });
  await gateway.start();
}, 30_000);

afterAll(async () => {
  await gateway?.close();
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("tenant model gateway", () => {
  it("brokers a bound capability and durably records streamed provider usage", async () => {
    const lease = await gateway.issue(command);
    expect(lease).toMatchObject({
      runtime: {
        kind: "openai_compatible_gateway",
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        reasoning: true,
      },
    });
    expect(JSON.stringify(lease)).not.toContain(PROVIDER_SECRET);
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          ...nextSamplingHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("chatcmpl-test");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const usage = await database
      .selectFrom("usage_ledger")
      .select([
        "tenant_id as tenantId",
        "turn_id as turnId",
        "input_tokens as inputTokens",
        "output_tokens as outputTokens",
        "cache_read_tokens as cacheReadTokens",
        "cost_microusd as costMicrousd",
      ])
      .where("turn_id", "=", IDS.turn)
      .orderBy("created_at", "asc")
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(usage).toMatchObject({
      tenantId: command.payload.tenantId,
      turnId: command.payload.turnId,
      inputTokens: "10",
      outputTokens: "3",
      cacheReadTokens: "2",
      costMicrousd: "17",
    });
    const requestAudit = await database
      .selectFrom("model_requests")
      .select([
        "state",
        "actual_model_id as actualModelId",
        "actual_input_microusd_per_million as actualInputRate",
        "actual_cost_microusd as costMicrousd",
        "step_context_sequence as stepSequence",
        "step_context_sha256 as stepSha256",
        "sampling_attempt as samplingAttempt",
      ])
      .where("turn_id", "=", IDS.turn)
      .orderBy("request_sequence", "asc")
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(requestAudit).toEqual({
      state: "completed",
      actualModelId: "deepseek-v4-flash",
      actualInputRate: "1000000",
      costMicrousd: "17",
      stepSequence: 1,
      stepSha256: "1".padStart(64, "0"),
      samplingAttempt: 1,
    });

    await lease.release();
    const revoked = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          ...nextSamplingHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, messages: [] }),
      },
    );
    expect(revoked.status).toBe(401);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong model before provider egress", async () => {
    const lease = await gateway.issue(command);
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          ...nextSamplingHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-pro", stream: true, messages: [] }),
      },
    );
    expect(response.status).toBe(403);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it("rejects a model request without its frozen Cloud Step identity", async () => {
    const callsBefore = upstreamFetch.mock.calls.length;
    const lease = await gateway.issue(command);
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, messages: [] }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "model_sampling_identity_invalid" },
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(callsBefore);
    await lease.release();
  });

  it("budgets and audits two Pi sampling attempts within the same Cloud Step", async () => {
    const callsBefore = upstreamFetch.mock.calls.length;
    const lease = await gateway.issue(command);
    const stepSequence = 900;
    const stepSha256 = "a".repeat(64);
    for (const samplingAttempt of [1, 2]) {
      const response = await fetch(
        `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${lease.runtime.capability}`,
            ...modelSamplingHeaders({ stepSequence, stepSha256, samplingAttempt }),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            stream: true,
            messages: [{ role: "user", content: "retry boundary" }],
          }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(upstreamFetch).toHaveBeenCalledTimes(callsBefore + 2);
    expect(
      await database
        .selectFrom("model_requests")
        .select([
          "step_context_sequence as stepSequence",
          "step_context_sha256 as stepSha256",
          "sampling_attempt as samplingAttempt",
          "state",
        ])
        .where("run_id", "=", command.payload.runId)
        .where("attempt_id", "=", command.payload.attemptId)
        .where("step_context_sequence", "=", stepSequence)
        .orderBy("sampling_attempt", "asc")
        .execute(),
    ).toEqual([
      { stepSequence, stepSha256, samplingAttempt: 1, state: "completed" },
      { stepSequence, stepSha256, samplingAttempt: 2, state: "completed" },
    ]);
    await lease.release();
  });

  it("denies an exhausted model-request limit before provider egress and audits it", async () => {
    const callsBefore = upstreamFetch.mock.calls.length;
    await database
      .updateTable("tenant_runtime_policies")
      .set({ maximum_model_requests_per_run: 1 })
      .where("tenant_id", "=", command.payload.tenantId)
      .executeTakeFirstOrThrow();
    const lease = await gateway.issue(command);
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          ...nextSamplingHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          stream: true,
          messages: [{ role: "user", content: "must not egress" }],
        }),
      },
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "model_request_limit" } });
    expect(upstreamFetch).toHaveBeenCalledTimes(callsBefore);
    expect(
      await database
        .selectFrom("model_requests")
        .select(["state", "failure_code as failureCode"])
        .where("turn_id", "=", IDS.turn)
        .where("state", "=", "budget_denied")
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "budget_denied", failureCode: "model_request_limit" });
    await lease.release();
  });

  it("falls back once on a configured rate limit and attributes usage to the actual model", async () => {
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("tenant_runtime_policies")
        .set({ maximum_model_requests_per_run: 32 })
        .where("tenant_id", "=", command.payload.tenantId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("model_rates")
        .values({
          tenant_id: command.payload.tenantId,
          provider: "deepseek",
          model_id: "deepseek-v4-pro",
          input_microusd_per_million: 2_000_000,
          output_microusd_per_million: 4_000_000,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      await transaction
        .updateTable("model_routing_policies")
        .set({
          fallback_provider: "deepseek",
          fallback_model_id: "deepseek-v4-pro",
          fallback_on_rate_limit: true,
          enabled: true,
        })
        .where("tenant_id", "=", command.payload.tenantId)
        .where("model_profile_id", "=", command.payload.model.profileId)
        .executeTakeFirstOrThrow();
    });
    upstreamFetch
      .mockImplementationOnce(
        async () =>
          new Response('{"error":"limited"}', { status: 429, headers: { "retry-after": "1" } }),
      )
      .mockImplementationOnce(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "deepseek-v4-pro" });
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"fallback"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
    const lease = await gateway.issue(command);
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          ...nextSamplingHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          stream: true,
          messages: [{ role: "user", content: "fallback" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fallback");
    const audit = await database
      .selectFrom("model_requests")
      .select(["actual_model_id as actualModelId", "fallback_reason as fallbackReason"])
      .where("turn_id", "=", IDS.turn)
      .where("fallback_reason", "=", "rate_limit")
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ actualModelId: "deepseek-v4-pro", fallbackReason: "rate_limit" });
    await lease.release();
  });

  it("allows cumulative Run usage above the former token cap", async () => {
    await database
      .updateTable("model_requests")
      .set({ actual_cache_read_tokens: 250_000 })
      .where("tenant_id", "=", command.payload.tenantId)
      .where("run_id", "=", command.payload.runId)
      .where("request_sequence", "=", 1)
      .executeTakeFirstOrThrow();
    const callsBefore = upstreamFetch.mock.calls.length;
    const lease = await gateway.issue(command);
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          ...nextSamplingHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          stream: true,
          messages: [{ role: "user", content: "continue after substantial cached context" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("chatcmpl-test");
    expect(upstreamFetch).toHaveBeenCalledTimes(callsBefore + 1);
    await lease.release();
  });
});
