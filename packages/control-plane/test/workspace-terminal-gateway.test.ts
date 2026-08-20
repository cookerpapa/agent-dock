import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
} from "@pi-cloud/protocol";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { ProductionHttpGateway } from "../src/production-http-gateway.ts";
import {
  DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH,
  WORKSPACE_TERMINAL_PATH,
  WorkspaceTerminalGateway,
} from "../src/workspace-terminal-gateway.ts";

const TOKEN = `terminal-api-${"a".repeat(48)}`;
const TERMINAL_TOKEN = `terminal-internal-${"t".repeat(48)}`;
const IDS = {
  tenant: "10000000-0000-4000-8000-000000000101",
  user: "10000000-0000-4000-8000-000000000102",
  project: "10000000-0000-4000-8000-000000000103",
  workspace: "10000000-0000-4000-8000-000000000104",
  credential: "10000000-0000-4000-8000-000000000105",
  profile: "10000000-0000-4000-8000-000000000106",
  environment: "10000000-0000-4000-8000-000000000107",
  session: "10000000-0000-4000-8000-000000000108",
  terminal: "10000000-0000-4000-8000-000000000109",
  development: "10000000-0000-4000-8000-000000000110",
  broker: "10000000-0000-4000-8000-000000000111",
} as const;

const closeTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closeTasks.splice(0).reverse()) await close();
});

function queuedFrames(socket: WebSocket): () => Promise<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  socket.on("message", (data: RawData) => {
    const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  });
  return () => {
    const frame = frames.shift();
    return frame === undefined
      ? new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve))
      : Promise.resolve(frame);
  };
}

async function seed(database: Kysely<Database>, toolBrokerBaseUrl: string): Promise<void> {
  await database.insertInto("tenants").values({ id: IDS.tenant, slug: "terminal-test" }).execute();
  await database
    .insertInto("users")
    .values({ id: IDS.user, tenant_id: IDS.tenant, display_name: "Terminal User" })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "test",
      kind: "api_key",
      secret_ref: "test://terminal",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "terminal",
      provider: "test",
      model_id: "test-model",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
    })
    .execute();
  await database
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "Terminal" })
    .execute();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      sandbox_domain_id: "sandbox-domain-0001",
      object_snapshot_key: null,
    })
    .execute();
  await database
    .insertInto("environment_versions")
    .values({
      id: IDS.environment,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      version_number: 1,
      profile_key: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
      profile_version: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
      image_revision: "terminal-test",
      spec_sha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipe_sha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      state: "pending",
      active: true,
      created_by_user_id: IDS.user,
      validated_at: null,
      failure_code: null,
    })
    .execute();
  await database
    .insertInto("sessions")
    .values({
      id: IDS.session,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: IDS.profile,
      state: "idle",
      workspace_snapshot_key: null,
    })
    .execute();
  await database
    .updateTable("sandbox_domains")
    .set({ tool_broker_base_url: toolBrokerBaseUrl })
    .where("id", "=", "sandbox-domain-0001")
    .executeTakeFirstOrThrow();
}

describe("WorkspaceTerminalGateway", () => {
  it("admits a pending first-use environment, derives identity, and rejects failed environments", async () => {
    let observedOpen: Record<string, unknown> | undefined;
    let observedInput: Record<string, unknown> | undefined;
    let observedDevelopmentOpen: Record<string, unknown> | undefined;
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => upstream.once("listening", resolve));
    closeTasks.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    upstream.on("connection", (socket, request) => {
      expect(request.url).toMatch(
        /^\/internal\/v1\/(?:workspace-terminal|development-environment-terminal)$/,
      );
      expect(request.headers.authorization).toBe(`Bearer ${TERMINAL_TOKEN}`);
      socket.on("message", (data: RawData) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (
          frame.type === "workspace_terminal.open" ||
          frame.type === "development_environment_terminal.open"
        ) {
          if (frame.type === "workspace_terminal.open") observedOpen = frame;
          else observedDevelopmentOpen = frame;
          socket.send(
            JSON.stringify({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.ready",
              terminalId: IDS.terminal,
              pid: 73,
              workspaceRoot: "/workspace",
            }),
          );
          return;
        }
        observedInput = frame;
        socket.send(
          JSON.stringify({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.pong" }),
        );
      });
    });
    const upstreamAddress = upstream.address();
    if (upstreamAddress === null || typeof upstreamAddress === "string") {
      throw new Error("terminal upstream did not bind TCP");
    }

    const pglite = await PGlite.create();
    const pgSocket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await pgSocket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${pgSocket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
    closeTasks.push(() => pglite.close());
    closeTasks.push(() => pgSocket.stop());
    closeTasks.push(() => database.destroy());
    await runMigrations(database, "up");
    await seed(database, `http://127.0.0.1:${String(upstreamAddress.port)}`);

    const server = Fastify({ logger: false });
    // Match production: the plugin and route are queued before Fastify becomes
    // ready, rather than awaiting plugin registration in isolation.
    server.register(fastifyWebsocket);
    new ProductionHttpGateway({
      authenticator: {
        authenticate: async (token) =>
          token === TOKEN
            ? {
                credentialId: IDS.credential,
                tenantId: IDS.tenant,
                tenantSlug: "terminal-test",
                userId: IDS.user,
                displayName: "Terminal User",
                role: "member",
                defaultModelProfileId: IDS.profile,
              }
            : undefined,
      },
      readiness: () => true,
    }).install(server);
    new WorkspaceTerminalGateway({
      database,
      terminalToken: TERMINAL_TOKEN,
      allowInsecureInternalHttp: true,
    }).install(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    closeTasks.push(() => server.close());

    const terminalUrl = new URL(
      WORKSPACE_TERMINAL_PATH.replace(":sessionId", IDS.session),
      address,
    );
    terminalUrl.protocol = "ws:";
    const browser = new WebSocket(terminalUrl, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    closeTasks.push(async () => {
      if (browser.readyState === WebSocket.OPEN) browser.close();
    });
    const nextFrame = queuedFrames(browser);
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    await expect(nextFrame()).resolves.toMatchObject({
      type: "workspace_terminal.ready",
      terminalId: IDS.terminal,
    });
    expect(observedOpen).toMatchObject({
      type: "workspace_terminal.open",
      tenantId: IDS.tenant,
      userId: IDS.user,
      projectId: IDS.project,
      workspaceId: IDS.workspace,
      sessionId: IDS.session,
      workspaceSeed: { kind: "snapshot" },
    });
    browser.send(
      JSON.stringify({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.ping",
      }),
    );
    await expect(nextFrame()).resolves.toMatchObject({ type: "workspace_terminal.pong" });
    expect(observedInput).toEqual({
      workspaceTerminalProtocolVersion: 1,
      type: "workspace_terminal.ping",
    });

    await database
      .insertInto("tool_broker_instances")
      .values({
        instance_id: IDS.broker,
        sandbox_domain_id: "sandbox-domain-0001",
        owner_base_url: `http://127.0.0.1:${String(upstreamAddress.port)}`,
        state: "ready",
        lease_expires_at: new Date(Date.now() + 60_000),
        last_heartbeat_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("development_environments")
      .values({
        id: IDS.development,
        tenant_id: IDS.tenant,
        owner_user_id: IDS.user,
        project_id: IDS.project,
        workspace_id: IDS.workspace,
        sandbox_domain_id: "sandbox-domain-0001",
        environment_version_id: IDS.environment,
        owner_instance_id: IDS.broker,
        owner_base_url: `http://127.0.0.1:${String(upstreamAddress.port)}`,
        generation: 1,
        runtime_id: IDS.development,
        runtime_name: "development-test",
        state: "running",
        failure_code: null,
        idempotency_key: "development-terminal",
        request_sha256: "a".repeat(64),
        released_at: null,
      })
      .executeTakeFirstOrThrow();
    const developmentUrl = new URL(
      DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH.replace(":environmentId", IDS.development),
      address,
    );
    developmentUrl.protocol = "ws:";
    const developmentBrowser = new WebSocket(developmentUrl, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    closeTasks.push(async () => {
      if (developmentBrowser.readyState === WebSocket.OPEN) developmentBrowser.close();
    });
    const nextDevelopmentFrame = queuedFrames(developmentBrowser);
    await new Promise<void>((resolve, reject) => {
      developmentBrowser.once("open", resolve);
      developmentBrowser.once("error", reject);
    });
    await expect(nextDevelopmentFrame()).resolves.toMatchObject({
      type: "workspace_terminal.ready",
    });
    expect(observedDevelopmentOpen).toMatchObject({
      type: "development_environment_terminal.open",
      environmentId: IDS.development,
      tenantId: IDS.tenant,
      userId: IDS.user,
    });

    await database
      .updateTable("environment_versions")
      .set({ state: "failed", failure_code: "environment_validation_failed" })
      .where("id", "=", IDS.environment)
      .executeTakeFirstOrThrow();
    const failed = new WebSocket(terminalUrl, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    closeTasks.push(async () => {
      if (failed.readyState === WebSocket.OPEN) failed.close();
    });
    const nextFailedFrame = queuedFrames(failed);
    await new Promise<void>((resolve, reject) => {
      failed.once("open", resolve);
      failed.once("error", reject);
    });
    await expect(nextFailedFrame()).resolves.toMatchObject({
      type: "workspace_terminal.error",
      code: "workspace_terminal_unavailable",
    });

    const unauthorized = new WebSocket(terminalUrl);
    await expect(
      new Promise<number>((resolve, reject) => {
        unauthorized.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        unauthorized.once("error", reject);
      }),
    ).resolves.toBe(401);
  }, 20_000);
});
