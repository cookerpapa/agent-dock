import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LIVE_PATH,
  CONTROL_PLANE_READY_PATH,
  ProductionHttpGateway,
  TENANT_REGISTRATION_PATH,
  tenantRequestIdentity,
} from "../src/index.ts";

const TOKEN = `api-${"a".repeat(48)}`;
const IDENTITY = {
  credentialId: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  tenantSlug: "gateway-test",
  userId: "00000000-0000-4000-8000-000000000003",
  displayName: "Gateway Test",
  role: "owner" as const,
  defaultModelProfileId: "00000000-0000-4000-8000-000000000004",
};

describe("ProductionHttpGateway", () => {
  it("protects every public v1 route while keeping safe health probes credential-free", async () => {
    let ready = false;
    const server = Fastify({ logger: false });
    new ProductionHttpGateway({
      authenticator: {
        authenticate: async (token) => (token === TOKEN ? IDENTITY : undefined),
      },
      readiness: () => ready,
    }).install(server);
    server.get("/v1/test", async (request) => ({ identity: tenantRequestIdentity(request) }));
    server.post(TENANT_REGISTRATION_PATH, async () => ({ registered: true }));
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      const unauthorized = await fetch(`${address}/v1/test`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
      await expect(unauthorized.json()).resolves.toEqual({
        error: {
          code: "authentication_required",
          message: "A valid AgentDock login session or API credential is required",
        },
      });
      const authenticated = await fetch(`${address}/v1/test`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(authenticated.status).toBe(200);
      await expect(authenticated.json()).resolves.toEqual({ identity: IDENTITY });
      const disabledRegistration = await fetch(`${address}${TENANT_REGISTRATION_PATH}`, {
        method: "POST",
      });
      expect(disabledRegistration.status).toBe(404);
      await expect(disabledRegistration.json()).resolves.toMatchObject({
        error: { code: "route_not_found" },
      });

      expect((await fetch(`${address}${CONTROL_PLANE_LIVE_PATH}`)).status).toBe(200);
      const unavailable = await fetch(`${address}${CONTROL_PLANE_READY_PATH}`);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ status: "not_ready" });
      ready = true;
      expect((await fetch(`${address}${CONTROL_PLANE_READY_PATH}`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("opens only the exact registration mutation when explicit public admission is enabled", async () => {
    const server = Fastify({ logger: false });
    new ProductionHttpGateway({
      authenticator: { authenticate: async () => undefined },
      readiness: () => true,
      publicRegistrationEnabled: true,
    }).install(server);
    server.post(TENANT_REGISTRATION_PATH, async () => ({ registered: true }));
    server.get(TENANT_REGISTRATION_PATH, async () => ({ listed: true }));
    server.post(`${TENANT_REGISTRATION_PATH}/extra`, async () => ({ registered: true }));
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      const registration = await fetch(`${address}${TENANT_REGISTRATION_PATH}`, {
        method: "POST",
      });
      expect(registration.status).toBe(200);
      await expect(registration.json()).resolves.toEqual({ registered: true });
      expect((await fetch(`${address}${TENANT_REGISTRATION_PATH}`)).status).toBe(401);
      expect(
        (
          await fetch(`${address}${TENANT_REGISTRATION_PATH}/extra`, {
            method: "POST",
          })
        ).status,
      ).toBe(401);
    } finally {
      await server.close();
    }
  });
});
