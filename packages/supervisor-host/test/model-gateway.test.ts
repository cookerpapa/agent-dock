import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  PostgresTenantModelCredentialResolver,
  TenantModelConfigurationService,
  TenantModelCredentialVault,
  createPrivateTenant,
  type TenantRequestIdentity,
} from "@agent-dock/control-plane";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { ExecuteTurnCommandMessage } from "@agent-dock/protocol";
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
  usage: "80000000-0000-4000-8000-000000000001",
} as const;
const PROVIDER_SECRET = `sk-${"p".repeat(48)}`;
const MASTER_KEY = Buffer.alloc(32, 21).toString("base64url");

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
      object_snapshot_key: null,
      created_at: now,
      updated_at: now,
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
      turnId: IDS.turn,
      agentId: "root",
      leaseId: IDS.lease,
      fencingToken: 1,
      nextEventSeq: 1,
      input: { kind: "prompt", text: "Repair it" },
      model: {
        profileId: tenant.defaultModelProfileId,
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        thinkingLevel: "off",
        credentialBindingId: tenant.credentialBindingId,
        credentialBindingVersion: 2,
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
    sandboxNetwork: "agent-dock-test_model-runtime",
    fetchImplementation: upstreamFetch,
    idGenerator: () => IDS.usage,
  });
  await gateway.start();
});

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
      network: "agent-dock-test_model-runtime",
      runtime: {
        kind: "openai_compatible_gateway",
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      },
    });
    expect(JSON.stringify(lease)).not.toContain(PROVIDER_SECRET);
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
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
      ])
      .where("id", "=", IDS.usage)
      .executeTakeFirstOrThrow();
    expect(usage).toMatchObject({
      tenantId: command.payload.tenantId,
      turnId: command.payload.turnId,
      inputTokens: "10",
      outputTokens: "3",
      cacheReadTokens: "2",
    });

    await lease.release();
    const revoked = await fetch(
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
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-pro", stream: true, messages: [] }),
      },
    );
    expect(response.status).toBe(403);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await lease.release();
  });
});
