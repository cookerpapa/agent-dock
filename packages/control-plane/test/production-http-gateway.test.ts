import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LIVE_PATH,
  CONTROL_PLANE_READY_PATH,
  ProductionHttpGateway,
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
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      const unauthorized = await fetch(`${address}/v1/test`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
      await expect(unauthorized.json()).resolves.toEqual({
        error: {
          code: "authentication_required",
          message: "A valid AgentDock API credential is required",
        },
      });
      const authenticated = await fetch(`${address}/v1/test`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(authenticated.status).toBe(200);
      await expect(authenticated.json()).resolves.toEqual({ identity: IDENTITY });

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
});
