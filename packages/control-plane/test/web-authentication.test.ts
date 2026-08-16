import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { AuthSessionResource, ProjectResource } from "@pi-cloud/protocol";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresTenantApiAuthenticator,
  PostgresTenantModelCredentialResolver,
  ProductionHttpGateway,
  TenantModelCredentialVault,
  WebAuthenticationService,
  createControlPlaneApplication,
  createPrivateTenant,
  resolvePlatformInitialModel,
} from "../src/index.ts";

const PASSWORD = "correct horse battery 123";
const PROVIDER_KEY = `sk-${"d".repeat(48)}`;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let application: NestFastifyApplication;
let http: FastifyInstance;
let vault: TenantModelCredentialVault;
let cookie = "";
let registration: AuthSessionResource;
let platformTenantId = "";
let platformApiToken = "";

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    // pglite-socket multiplexing is not PostgreSQL wire-compatible under
    // concurrent parse/execute traffic; one connection keeps this integration
    // test deterministic while production tests use real PostgreSQL.
    maxConnections: 1,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  vault = new TenantModelCredentialVault(Buffer.alloc(32, 9).toString("base64url"));
  const platform = await createPrivateTenant(database, {
    slug: "platform-operator",
    ownerDisplayName: "Platform Operator",
    initialModel: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      apiKey: PROVIDER_KEY,
      vault,
    },
  });
  platformTenantId = platform.tenantId;
  platformApiToken = platform.credential.token;
  const initialModel = await resolvePlatformInitialModel(database, vault, platform.tenantId);
  expect(initialModel).toMatchObject({ provider: "deepseek", modelId: "deepseek-v4-flash" });
  const webAuthentication = new WebAuthenticationService({
    database,
    enabled: true,
    maximumTenants: 4,
    tenantQuotas: {
      maximumProjects: 10,
      maximumSessions: 100,
      maximumUnsettledTurns: 10,
      maximumConcurrentTurns: 1,
      maximumActiveSandboxes: 2,
    },
    initialModel: () => resolvePlatformInitialModel(database, vault, platform.tenantId),
  });
  application = await createControlPlaneApplication({
    database,
    webAuthentication,
    modelCredentialVault: vault,
    platformOperatorTenantId: platform.tenantId,
    productionHttpGateway: new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database }),
      webSessionAuthenticator: webAuthentication,
      publicRegistrationEnabled: true,
      readiness: () => true,
    }),
  });
  await application.listen(0, "127.0.0.1");
  http = application.getHttpAdapter().getInstance() as FastifyInstance;
}, 30_000);

afterAll(async () => {
  await application?.close();
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("product web authentication", () => {
  it("registers a password account, issues an HttpOnly cookie, and inherits the platform model", async () => {
    const response = await http.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "alice.dev", displayName: "Alice", password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    registration = response.json<AuthSessionResource>();
    expect(registration).toMatchObject({
      identity: { displayName: "Alice", role: "owner" },
    });
    expect(response.body).not.toContain("apiToken");
    expect(response.body).not.toContain(PASSWORD);
    const setCookie = response.headers["set-cookie"];
    expect(typeof setCookie).toBe("string");
    expect(setCookie).toContain("pi_cloud_session=ads_");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    cookie = String(setCookie).split(";", 1)[0]!;

    const account = await database
      .selectFrom("user_password_credentials")
      .select(["username", "password_hash as passwordHash", "password_salt as passwordSalt"])
      .where("username", "=", "alice.dev")
      .executeTakeFirstOrThrow();
    expect(account.passwordHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(account.passwordSalt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(account)).not.toContain(PASSWORD);

    const profile = await database
      .selectFrom("tenant_runtime_policies as policy")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .select([
        "profile.provider",
        "profile.model_id as modelId",
        "profile.credential_binding_id as bindingId",
        "profile.credential_binding_version as bindingVersion",
      ])
      .where("policy.tenant_id", "=", registration.identity.tenantId)
      .executeTakeFirstOrThrow();
    expect(profile).toMatchObject({ provider: "deepseek", modelId: "deepseek-v4-flash" });
    const resolved = await new PostgresTenantModelCredentialResolver({ database, vault }).resolve({
      tenantId: registration.identity.tenantId,
      credentialBindingId: profile.bindingId,
      credentialBindingVersion: Number(profile.bindingVersion),
      provider: "deepseek",
    });
    expect(resolved.secret).toBe(PROVIDER_KEY);
  });

  it("authenticates API requests with the browser cookie and keeps tenants isolated", async () => {
    const identity = await http.inject({ method: "GET", url: "/v1/identity", headers: { cookie } });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toEqual(registration.identity);

    const projectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Empty product chat", source: { kind: "empty" } },
    });
    expect(projectResponse.statusCode).toBe(201);
    expect(projectResponse.json<ProjectResource>()).toMatchObject({
      name: "Empty product chat",
      source: { kind: "empty", status: "ready" },
    });

    const modelReplacement = await http.inject({
      method: "PUT",
      url: "/v1/model-configuration",
      headers: { cookie },
      payload: {
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        apiKey: `sk-${"x".repeat(48)}`,
      },
    });
    expect(registration.identity.tenantId).not.toBe(platformTenantId);
    expect(modelReplacement.statusCode).toBe(403);
    expect(modelReplacement.json()).toEqual({
      error: {
        code: "authorization_denied",
        message: "Model configuration is managed by the platform operator",
      },
    });

    const rotatedProviderKey = `sk-${"r".repeat(48)}`;
    const platformReplacement = await http.inject({
      method: "PUT",
      url: "/v1/model-configuration",
      headers: { authorization: `Bearer ${platformApiToken}` },
      payload: {
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        apiKey: rotatedProviderKey,
      },
    });
    expect(platformReplacement.statusCode).toBe(200);
    expect(platformReplacement.json()).toMatchObject({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      credentialVersion: 2,
    });
    const rotatedProfile = await database
      .selectFrom("tenant_runtime_policies as policy")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .select([
        "profile.model_id as modelId",
        "profile.credential_binding_id as bindingId",
        "profile.credential_binding_version as bindingVersion",
      ])
      .where("policy.tenant_id", "=", registration.identity.tenantId)
      .executeTakeFirstOrThrow();
    expect(rotatedProfile).toMatchObject({ modelId: "deepseek-v4-pro", bindingVersion: "2" });
    expect(
      (
        await new PostgresTenantModelCredentialResolver({ database, vault }).resolve({
          tenantId: registration.identity.tenantId,
          credentialBindingId: rotatedProfile.bindingId,
          credentialBindingVersion: Number(rotatedProfile.bindingVersion),
          provider: "deepseek",
        })
      ).secret,
    ).toBe(rotatedProviderKey);
  });

  it("uses generic login failures, rotates sessions, and revokes logout immediately", async () => {
    const wrong = await http.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "alice.dev", password: "definitely wrong password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({
      error: { code: "invalid_credentials", message: "Username or password is incorrect" },
    });
    const missing = await http.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "nobody", password: "definitely wrong password" },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual(wrong.json());

    const login = await http.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "ALICE.DEV", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const loginCookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    expect(loginCookie).not.toBe(cookie);

    const logout = await http.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: loginCookie },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ loggedOut: true });
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    expect(
      (await http.inject({ method: "GET", url: "/v1/identity", headers: { cookie: loginCookie } }))
        .statusCode,
    ).toBe(401);
  });

  it("resolves the current platform model when a later account registers", async () => {
    const response = await http.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "bob.dev", displayName: "Bob", password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const bob = response.json<AuthSessionResource>();
    const profile = await database
      .selectFrom("tenant_runtime_policies as policy")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .select(["profile.model_id as modelId", "profile.credential_binding_version as version"])
      .where("policy.tenant_id", "=", bob.identity.tenantId)
      .executeTakeFirstOrThrow();
    expect(profile).toEqual({ modelId: "deepseek-v4-pro", version: "1" });
  });

  it("rejects duplicate usernames without exposing or replacing the existing account", async () => {
    const duplicate = await http.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { username: "ALICE.DEV", displayName: "Other Alice", password: PASSWORD },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "username_unavailable" } });
    expect(
      await database
        .selectFrom("user_password_credentials")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("username", "=", "alice.dev")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "1" });
  });
});
