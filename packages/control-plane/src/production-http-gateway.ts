import type { FastifyInstance } from "fastify";
import { bindTenantRequestIdentity, type TenantApiAuthenticator } from "./tenant-identity.ts";

export const CONTROL_PLANE_LIVE_PATH = "/health/live";
export const CONTROL_PLANE_READY_PATH = "/health/ready";
export const TENANT_REGISTRATION_PATH = "/v1/registrations";

export type ProductionHttpGatewayOptions = {
  authenticator: TenantApiAuthenticator;
  readiness: () => boolean | Promise<boolean>;
  publicRegistrationEnabled?: boolean;
};

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

export class ProductionHttpGateway {
  readonly #authenticator: TenantApiAuthenticator;
  readonly #readiness: () => boolean | Promise<boolean>;
  readonly #publicRegistrationEnabled: boolean;
  #installed = false;

  constructor(options: ProductionHttpGatewayOptions) {
    this.#authenticator = options.authenticator;
    this.#readiness = options.readiness;
    this.#publicRegistrationEnabled = options.publicRegistrationEnabled ?? false;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Production HTTP gateway is already installed");
    this.#installed = true;
    fastify.addHook("onRequest", async (request, reply) => {
      const path = request.raw.url?.split("?", 1)[0] ?? "";
      if (!path.startsWith("/v1/") && path !== "/v1") return;
      if (request.method === "POST" && path === TENANT_REGISTRATION_PATH) {
        if (this.#publicRegistrationEnabled) return;
        await reply.code(404).send({
          error: {
            code: "route_not_found",
            message: "The requested API route was not found",
          },
        });
        return;
      }
      const token = bearerToken(request.headers.authorization);
      let identity;
      try {
        identity = token === undefined ? undefined : await this.#authenticator.authenticate(token);
      } catch {
        await reply.code(503).send({
          error: {
            code: "authentication_unavailable",
            message: "The AgentDock identity service is temporarily unavailable",
          },
        });
        return;
      }
      if (identity !== undefined) {
        bindTenantRequestIdentity(request, identity);
        return;
      }
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
