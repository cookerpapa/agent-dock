import type { Database } from "@agent-dock/database";
import type { TenantApiAuthenticator } from "@agent-dock/control-plane/tenant-identity";
import { readWebSessionCookie } from "@agent-dock/control-plane/web-authentication";
import {
  DurableEventStoreError,
  type DurableEventLog,
} from "@agent-dock/runtime-core/durable-event-store";
import { SessionEventHub } from "@agent-dock/runtime-core/session-event-hub";
import type { SessionEventNotificationTransport } from "@agent-dock/runtime-core/session-event-notifications";
import { SessionEventStream } from "@agent-dock/runtime-core/session-event-stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";

const SESSION_EVENT_PATH = "/v1/sessions/:sessionId/events";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EventGatewayOptions = {
  database: Kysely<Database>;
  eventLog: DurableEventLog;
  apiAuthenticator: TenantApiAuthenticator;
  webSessionAuthenticator: TenantApiAuthenticator;
  notifications: SessionEventNotificationTransport;
  eventHub?: SessionEventHub;
  heartbeatIntervalMs?: number;
  replayPageSize?: number;
};

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

function parseSessionId(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function parseLastEventId(value: unknown): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function authenticate(
  request: FastifyRequest,
  apiAuthenticator: TenantApiAuthenticator,
  webSessionAuthenticator: TenantApiAuthenticator,
) {
  const bearer = bearerToken(request.headers.authorization);
  if (bearer !== undefined) return apiAuthenticator.authenticate(bearer);
  const webSession = readWebSessionCookie(request.headers.cookie);
  return webSession === undefined ? undefined : webSessionAuthenticator.authenticate(webSession);
}

async function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): Promise<void> {
  await reply.code(statusCode).send({ error: { code, message } });
}

export class EventGateway {
  readonly application: FastifyInstance;
  readonly eventHub: SessionEventHub;
  readonly #database: Kysely<Database>;
  readonly #notifications: SessionEventNotificationTransport;
  readonly #stream: SessionEventStream;
  #started = false;
  #closing: Promise<void> | undefined;

  constructor(options: EventGatewayOptions) {
    this.#database = options.database;
    this.#notifications = options.notifications;
    this.eventHub = options.eventHub ?? new SessionEventHub();
    this.#stream = new SessionEventStream(options.eventLog, this.eventHub, {
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.replayPageSize === undefined ? {} : { replayPageSize: options.replayPageSize }),
    });
    this.application = Fastify({ logger: false });
    this.application.get("/health/live", async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    this.application.get("/health/ready", async (_request, reply) => {
      let ready = false;
      try {
        await sql`select 1`.execute(this.#database);
        ready = this.#started;
      } catch {
        ready = false;
      }
      await reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
    });
    this.application.get(SESSION_EVENT_PATH, async (request, reply) => {
      let identity;
      try {
        identity = await authenticate(
          request,
          options.apiAuthenticator,
          options.webSessionAuthenticator,
        );
      } catch {
        await sendError(
          reply,
          503,
          "authentication_unavailable",
          "The AgentDock identity service is temporarily unavailable",
        );
        return;
      }
      if (identity === undefined) {
        reply.header("www-authenticate", "Bearer");
        await sendError(
          reply,
          401,
          "authentication_required",
          "A valid AgentDock login session or API credential is required",
        );
        return;
      }
      const parameters = request.params as { sessionId?: unknown };
      const sessionId = parseSessionId(parameters.sessionId);
      const afterSequence = parseLastEventId(request.headers["last-event-id"]);
      if (sessionId === undefined || afterSequence === undefined) {
        await sendError(reply, 400, "invalid_request", "The event stream request is invalid");
        return;
      }
      let stream;
      try {
        stream = await this.#stream.open(identity.tenantId, sessionId, afterSequence);
      } catch (error: unknown) {
        if (error instanceof DurableEventStoreError && error.code === "not_found") {
          await sendError(reply, 404, "session_not_found", "The Session was not found");
          return;
        }
        await sendError(reply, 503, "event_stream_unavailable", "The event stream is unavailable");
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      });
      reply.raw.flushHeaders();
      try {
        await stream.pipe(reply.raw);
      } catch {
        reply.raw.destroy();
      } finally {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    });
  }

  async listen(port: number, host: string): Promise<string> {
    if (this.#started) throw new Error("Event Gateway can only listen once");
    await this.#notifications.start({
      onNotification: (notification) =>
        this.eventHub.notifyThrough(
          notification.tenantId,
          notification.sessionId,
          notification.throughSequence,
        ),
      onResync: () => this.eventHub.resyncAll(),
    });
    try {
      const address = await this.application.listen({ port, host });
      this.#started = true;
      return address;
    } catch (error: unknown) {
      await this.#notifications.stop().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.eventHub.onApplicationShutdown();
    await this.#notifications.stop();
    await this.application.close();
    this.#started = false;
  }
}
