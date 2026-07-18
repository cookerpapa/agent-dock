import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import {
  parseAcceptTurnRequest,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseIdempotencyKey,
  parseLastEventIdHeader,
  parseUuidPathParameter,
  type AcceptedTurnResource,
  type ProjectResource,
  type SessionResource,
} from "@agent-dock/protocol";
import type { FastifyReply } from "fastify";
import { ControlPlaneStore } from "./control-plane-store.ts";
import { SessionEventStream } from "./session-event-stream.ts";

export const CONTROL_PLANE_STORE = Symbol("CONTROL_PLANE_STORE");

@Controller("v1")
export class ControlPlaneController {
  constructor(
    @Inject(CONTROL_PLANE_STORE) private readonly controlPlaneStore: ControlPlaneStore,
    @Inject(SessionEventStream) private readonly sessionEventStream: SessionEventStream,
  ) {}

  @Post("projects")
  async createProject(@Body() body: unknown): Promise<ProjectResource> {
    const request = parseCreateProjectRequest(body);
    return this.controlPlaneStore.createProject(request.name);
  }

  @Post("projects/:projectId/sessions")
  async createSession(
    @Param("projectId") projectIdValue: unknown,
    @Body() body: unknown,
  ): Promise<SessionResource> {
    const projectId = parseUuidPathParameter(projectIdValue, "projectId");
    const request = parseCreateSessionRequest(body);
    return this.controlPlaneStore.createSession(projectId, request.workspaceId);
  }

  @Post("sessions/:sessionId/turns")
  @HttpCode(202)
  async acceptTurn(
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<AcceptedTurnResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const request = parseAcceptTurnRequest(body);
    return this.controlPlaneStore.acceptTurn(sessionId, idempotencyKey, request);
  }

  @Get("sessions/:sessionId/events")
  async streamSessionEvents(
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("last-event-id") lastEventIdValue: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const afterSequence = parseLastEventIdHeader(lastEventIdValue);
    const stream = await this.sessionEventStream.open(sessionId, afterSequence);

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
      // The SSE status and headers are already committed. Closing forces the
      // browser to reconnect with its last successfully received event ID.
      reply.raw.destroy();
    } finally {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  }
}
