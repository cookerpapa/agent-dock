import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LIVE_PATH,
  CONTROL_PLANE_READY_PATH,
  ProductionHttpGateway,
} from "../src/index.ts";

const TOKEN = `api-${"a".repeat(48)}`;

describe("ProductionHttpGateway", () => {
  it("protects every public v1 route while keeping safe health probes credential-free", async () => {
    let ready = false;
    const server = Fastify({ logger: false });
    new ProductionHttpGateway({ apiToken: TOKEN, readiness: () => ready }).install(server);
    server.get("/v1/test", async () => ({ secret: "never-a-real-secret" }));
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
      expect(
        (
          await fetch(`${address}/v1/test`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).status,
      ).toBe(200);

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
