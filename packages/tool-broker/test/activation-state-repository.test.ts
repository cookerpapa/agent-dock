import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@agent-dock/database";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresSandboxActivationStateRepository } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("PostgreSQL Tool Broker ownership", () => {
  it("resolves a Workspace through its Sandbox Domain without ambiguous columns", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
    resources.push(async () => pglite.close());
    resources.push(async () => socket.stop());
    resources.push(async () => database.destroy());
    await runMigrations(database, "up");

    const tenantId = "20000000-0000-4000-8000-000000000001";
    const projectId = "20000000-0000-4000-8000-000000000002";
    const workspaceId = "20000000-0000-4000-8000-000000000003";
    await database.insertInto("tenants").values({ id: tenantId, slug: "reservation" }).execute();
    await database
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "reservation" })
      .execute();
    await database
      .insertInto("workspaces")
      .values({
        id: workspaceId,
        tenant_id: tenantId,
        project_id: projectId,
        sandbox_domain_id: "sandbox-domain-0001",
        object_snapshot_key: null,
      })
      .execute();
    const credentialId = "20000000-0000-4000-8000-000000000010";
    const profileId = "20000000-0000-4000-8000-000000000011";
    const rootSessionId = "20000000-0000-4000-8000-000000000012";
    const childSessionId = "20000000-0000-4000-8000-000000000013";
    const unrelatedSessionId = "20000000-0000-4000-8000-000000000014";
    const forkTurnId = "20000000-0000-4000-8000-000000000015";
    await database
      .insertInto("credential_bindings")
      .values({
        id: credentialId,
        tenant_id: tenantId,
        provider: "test",
        kind: "api_key",
        secret_ref: "test://credential",
        version: 1,
        status: "active",
      })
      .execute();
    await database
      .insertInto("model_profiles")
      .values({
        id: profileId,
        tenant_id: tenantId,
        name: "tree-reservation",
        provider: "test",
        model_id: "test-model",
        default_thinking_level: "off",
        allowed_thinking_levels: ["off"],
        credential_binding_id: credentialId,
        credential_binding_version: 1,
      })
      .execute();
    await database
      .insertInto("sessions")
      .values(
        [rootSessionId, unrelatedSessionId].map((id) => ({
          id,
          tenant_id: tenantId,
          project_id: projectId,
          workspace_id: workspaceId,
          desired_model_profile_id: profileId,
          state: "idle" as const,
          pi_session_snapshot_key: null,
          workspace_snapshot_key: null,
        })),
      )
      .execute();
    await database
      .insertInto("turns")
      .values({
        id: forkTurnId,
        tenant_id: tenantId,
        session_id: rootSessionId,
        state: "completed",
        input_kind: "prompt",
        input_text: "seed",
        model_profile_id: profileId,
        provider: "test",
        model_id: "test-model",
        thinking_level: "off",
        credential_binding_id: credentialId,
        credential_binding_version: 1,
        stop_reason: "stop",
        failure_code: null,
        failure_message: null,
        failure_retryable: null,
        started_at: new Date(),
        settled_at: new Date(),
      })
      .execute();
    await database
      .insertInto("sessions")
      .values({
        id: childSessionId,
        tenant_id: tenantId,
        project_id: projectId,
        workspace_id: workspaceId,
        desired_model_profile_id: profileId,
        state: "idle",
        pi_session_snapshot_key: null,
        workspace_snapshot_key: null,
        conversation_parent_session_id: rootSessionId,
        conversation_fork_turn_id: forkTurnId,
        conversation_fork_entry_id: "20000000-0000-4000-8000-000000000016",
      })
      .execute();

    const repository = new PostgresSandboxActivationStateRepository({
      database,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId: "20000000-0000-4000-8000-000000000004",
      ownerBaseUrl: "http://tool-broker-0:4300",
    });
    resources.push(async () => repository.close());
    await repository.start();

    await expect(
      repository.allowsPersistentConversationHandoff({
        tenantId,
        workspaceId,
        currentSessionId: rootSessionId,
        nextSessionId: childSessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.allowsPersistentConversationHandoff({
        tenantId,
        workspaceId,
        currentSessionId: rootSessionId,
        nextSessionId: unrelatedSessionId,
      }),
    ).resolves.toBe(false);

    await expect(
      repository.reserve({
        activationId: "20000000-0000-4000-8000-000000000005",
        assignment: {
          tenantId,
          projectId,
          workspaceId,
          supervisorId: "supervisor-reservation",
          bootId: "20000000-0000-4000-8000-000000000006",
          sandboxId: "20000000-0000-4000-8000-000000000007",
          commandId: "command-reservation",
          sessionId: "session-reservation",
          turnId: "turn-reservation",
          attemptId: "20000000-0000-4000-8000-000000000008",
          leaseId: "20000000-0000-4000-8000-000000000009",
          fencingToken: 1,
        },
        capabilitySha256: "a".repeat(64),
        turnContextSha256: "b".repeat(64),
        attemptContextSha256: "c".repeat(64),
        environmentSha256: "d".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "state_conflict",
      message: "Tenant Sandbox policy is unavailable",
    });
  }, 15_000);

  it("fences an expired replica before a surviving owner stays Ready", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
    resources.push(async () => pglite.close());
    resources.push(async () => socket.stop());
    resources.push(async () => database.destroy());
    await runMigrations(database, "up");

    let now = new Date("2026-08-09T00:00:00.000Z");
    const first = new PostgresSandboxActivationStateRepository({
      database,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId: "10000000-0000-4000-8000-000000000101",
      ownerBaseUrl: "http://tool-broker-0:4300",
      leaseMs: 3_000,
      heartbeatMs: 1_000,
      clock: () => now,
    });
    resources.push(async () => first.close());
    await first.start();
    await expect(first.checkHealth()).resolves.toBeUndefined();

    now = new Date("2026-08-09T00:00:04.000Z");
    const second = new PostgresSandboxActivationStateRepository({
      database,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId: "10000000-0000-4000-8000-000000000102",
      ownerBaseUrl: "http://tool-broker-1:4300",
      leaseMs: 3_000,
      heartbeatMs: 1_000,
      clock: () => now,
    });
    resources.push(async () => second.close());
    await second.start();

    await expect(first.checkHealth()).rejects.toMatchObject({ code: "ownership_lost" });
    await expect(second.checkHealth()).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("tool_broker_instances")
        .select(["instance_id", "state"])
        .orderBy("instance_id")
        .execute(),
    ).resolves.toEqual([
      { instance_id: "10000000-0000-4000-8000-000000000101", state: "lost" },
      { instance_id: "10000000-0000-4000-8000-000000000102", state: "ready" },
    ]);
  }, 15_000);
});
