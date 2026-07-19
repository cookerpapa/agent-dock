import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export const CONTROL_PLANE_LIVE_PATH = "/health/live";
export const CONTROL_PLANE_READY_PATH = "/health/ready";

export type ProductionHttpGatewayOptions = {
  apiToken: string;
  readiness: () => boolean | Promise<boolean>;
};

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function boundedToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("apiToken must contain 32-4096 bounded ASCII bytes");
  }
  return value;
}

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

export class ProductionHttpGateway {
  readonly #apiDigest: Buffer;
  readonly #readiness: () => boolean | Promise<boolean>;
  #installed = false;

  constructor(options: ProductionHttpGatewayOptions) {
    this.#apiDigest = tokenDigest(boundedToken(options.apiToken));
    this.#readiness = options.readiness;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Production HTTP gateway is already installed");
    this.#installed = true;
    fastify.addHook("onRequest", async (request, reply) => {
      const path = request.raw.url?.split("?", 1)[0] ?? "";
      if (!path.startsWith("/v1/") && path !== "/v1") return;
      const token = bearerToken(request.headers.authorization);
      const candidate = token === undefined ? Buffer.alloc(32) : tokenDigest(token);
      if (token !== undefined && timingSafeEqual(this.#apiDigest, candidate)) return;
      await reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({
          error: {
            code: "authentication_required",
            message: "A valid AgentDock API credential is required",
          },
        });
    });
    fastify.get(CONTROL_PLANE_LIVE_PATH, async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    fastify.get(CONTROL_PLANE_READY_PATH, async (_request, reply) => {
      let ready = false;
      try {
        ready = await this.#readiness();
      } catch {
        ready = false;
      }
      await reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
    });
  }
}
