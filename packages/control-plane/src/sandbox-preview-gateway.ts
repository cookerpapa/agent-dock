import type { Database } from "@pi-cloud/database";
import {
  TOOL_BROKER_SANDBOX_PREVIEW_PATH,
  SANDBOX_PREVIEW_PORTS,
  parseSandboxPreviewResponse,
  parseUuidPathParameter,
  type SandboxPreviewRequest,
  type SandboxPreviewTarget,
} from "@pi-cloud/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { tenantRequestIdentity } from "./tenant-identity.ts";

export const CONVERSATION_PREVIEW_PATH = "/v1/conversations/:sessionId/preview/:port/*";
export const DEVELOPMENT_ENVIRONMENT_PREVIEW_PATH =
  "/v1/development-environments/:environmentId/preview/:port/*";

const MAXIMUM_REDIRECTS = 3;
const MAXIMUM_REQUEST_BYTES = 4 * 1_024 * 1_024;

export type SandboxPreviewGatewayOptions = Readonly<{
  database: Kysely<Database>;
  previewToken: string;
  allowInsecureInternalHttp: boolean;
}>;

function previewPort(value: unknown): SandboxPreviewRequest["port"] {
  const parsed = Number(value);
  if (!SANDBOX_PREVIEW_PORTS.some((port) => port === parsed)) {
    throw new Error("Preview port is not exposed by the deployment template");
  }
  return parsed as SandboxPreviewRequest["port"];
}

function requestBody(request: FastifyRequest): Buffer | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  const body = Buffer.isBuffer(request.body)
    ? request.body
    : Buffer.from(
        typeof request.body === "string" ? request.body : JSON.stringify(request.body),
        "utf8",
      );
  if (body.byteLength > MAXIMUM_REQUEST_BYTES) throw new Error("Preview request body is too large");
  return body;
}

function requestHeaders(request: FastifyRequest): Readonly<Record<string, string>> {
  const allowed = new Set([
    "accept",
    "accept-language",
    "content-type",
    "if-modified-since",
    "if-none-match",
    "range",
    "user-agent",
  ]);
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(request.headers)) {
    if (!allowed.has(name.toLowerCase()) || typeof raw !== "string") continue;
    headers[name.toLowerCase()] = raw.slice(0, 8_192);
  }
  return Object.freeze(headers);
}

function publicPrefix(target: SandboxPreviewTarget, port: number): string {
  return target.kind === "conversation"
    ? `/v1/conversations/${encodeURIComponent(target.sessionId)}/preview/${String(port)}`
    : `/v1/development-environments/${encodeURIComponent(target.environmentId)}/preview/${String(port)}`;
}

function rewriteHtml(body: Buffer, prefix: string): Buffer {
  if (body.byteLength > 4 * 1_024 * 1_024) return body;
  const html = body.toString("utf8");
  if (!/<(?:html|head)[\s>]/iu.test(html)) return body;
  const base = `<base href="${prefix}/">`;
  return Buffer.from(
    /<head[\s>]/iu.test(html) ? html.replace(/(<head[^>]*>)/iu, `$1${base}`) : `${base}${html}`,
    "utf8",
  );
}

export class SandboxPreviewGateway {
  readonly #database: Kysely<Database>;
  readonly #previewToken: string;
  readonly #allowInsecureInternalHttp: boolean;
  #installed = false;

  constructor(options: SandboxPreviewGatewayOptions) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.previewToken)) {
      throw new TypeError("Sandbox preview gateway token is invalid");
    }
    this.#database = options.database;
    this.#previewToken = options.previewToken;
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Sandbox preview gateway is already installed");
    this.#installed = true;
    fastify.register(async (scope) => {
      scope.all(CONVERSATION_PREVIEW_PATH, (request, reply) =>
        this.#handle(request, reply, "conversation"),
      );
      scope.all(DEVELOPMENT_ENVIRONMENT_PREVIEW_PATH, (request, reply) =>
        this.#handle(request, reply, "development_environment"),
      );
    });
  }

  async #handle(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: SandboxPreviewTarget["kind"],
  ): Promise<void> {
    const identity = tenantRequestIdentity(request);
    if (identity === undefined) {
      await reply.code(401).send({ error: "authentication_required" });
      return;
    }
    try {
      const params = request.params as Record<string, unknown>;
      const target: SandboxPreviewTarget =
        kind === "conversation"
          ? {
              kind,
              sessionId: parseUuidPathParameter(params.sessionId, "sessionId"),
            }
          : {
              kind,
              environmentId: parseUuidPathParameter(params.environmentId, "environmentId"),
            };
      const port = previewPort(params.port);
      const suffix = typeof params["*"] === "string" ? params["*"] : "";
      const search = new URL(request.raw.url ?? "/", "http://pi-cloud.local").search;
      const method = request.method as SandboxPreviewRequest["method"];
      if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).has(method)) {
        throw new Error("Preview HTTP method is unsupported");
      }
      const baseUrl = await this.#resolveBaseUrl(identity.tenantId, identity.userId, target);
      const body = requestBody(request);
      const response = await this.#forward(baseUrl, 0, {
        sandboxPreviewProtocolVersion: 1,
        type: "sandbox_preview.request",
        requestId: randomUUID(),
        tenantId: identity.tenantId,
        userId: identity.userId,
        target,
        port,
        method,
        path: `/${suffix}${search}`,
        headers: requestHeaders(request),
        ...(body === undefined ? {} : { body: body.toString("base64") }),
      });
      if (response.type !== "sandbox_preview.response") {
        throw new Error("Preview owner redirect did not resolve");
      }
      const prefix = publicPrefix(target, port);
      for (const [name, value] of Object.entries(response.headers)) {
        if (name === "content-encoding") continue;
        reply.header(
          name,
          name === "location" && value.startsWith("/") ? `${prefix}${value}` : value,
        );
      }
      reply.header("cache-control", response.headers["cache-control"] ?? "no-store");
      reply.header(
        "content-security-policy",
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; " +
          "default-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
      );
      reply.header("cross-origin-resource-policy", "same-origin");
      reply.header("x-content-type-options", "nosniff");
      let responseBody: Uint8Array = Buffer.from(response.body, "base64");
      if ((response.headers["content-type"] ?? "").toLowerCase().includes("text/html")) {
        responseBody = rewriteHtml(Buffer.from(responseBody), prefix);
      }
      await reply
        .code(response.status)
        .send(method === "HEAD" ? undefined : Buffer.from(responseBody));
    } catch (error: unknown) {
      request.log.warn({ err: error }, "Sandbox preview request failed");
      await reply.code(503).send({
        error: "sandbox_preview_unavailable",
        message: "Sandbox service is not currently reachable",
      });
    }
  }

  async #resolveBaseUrl(
    tenantId: string,
    userId: string,
    target: SandboxPreviewTarget,
  ): Promise<string> {
    if (target.kind === "development_environment") {
      const row = await this.#database
        .selectFrom("development_environments as development")
        .innerJoin("sandbox_domains as domain", "domain.id", "development.sandbox_domain_id")
        .select([
          "development.owner_base_url as ownerBaseUrl",
          "domain.tool_broker_base_url as fallbackBaseUrl",
        ])
        .where("development.tenant_id", "=", tenantId)
        .where("development.owner_user_id", "=", userId)
        .where("development.id", "=", target.environmentId)
        .where("development.state", "=", "running")
        .executeTakeFirst();
      if (row === undefined) throw new Error("Development environment preview is unavailable");
      return row.ownerBaseUrl ?? row.fallbackBaseUrl;
    }
    const row = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .innerJoin("sandbox_domains as domain", "domain.id", "workspace.sandbox_domain_id")
      .leftJoin("tool_broker_activations as activation", (join) =>
        join
          .onRef("activation.tenant_id", "=", "session_row.tenant_id")
          .onRef("activation.session_id", "=", "session_row.id")
          .on("activation.state", "in", ["materializing", "active", "warm", "cleaning"]),
      )
      .select([
        "activation.owner_base_url as ownerBaseUrl",
        "domain.tool_broker_base_url as fallbackBaseUrl",
      ])
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", target.sessionId)
      .where("session_row.archived_at", "is", null)
      .orderBy("activation.updated_at", "desc")
      .executeTakeFirst();
    if (row === undefined) throw new Error("Conversation preview is unavailable");
    return row.ownerBaseUrl ?? row.fallbackBaseUrl;
  }

  async #forward(
    baseUrl: string,
    redirects: number,
    message: SandboxPreviewRequest,
  ): Promise<ReturnType<typeof parseSandboxPreviewResponse>> {
    if (redirects > MAXIMUM_REDIRECTS) throw new Error("Too many Tool Broker redirects");
    const target = new URL(TOOL_BROKER_SANDBOX_PREVIEW_PATH, baseUrl);
    if (target.protocol === "http:" && !this.#allowInsecureInternalHttp) {
      throw new Error("Insecure Tool Broker preview URL was rejected");
    }
    const response = await fetch(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#previewToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(70_000),
    });
    const parsed = parseSandboxPreviewResponse(await response.json());
    if (parsed.type === "sandbox_preview.owner_redirect") {
      return this.#forward(parsed.ownerBaseUrl, redirects + 1, message);
    }
    return parsed;
  }
}
