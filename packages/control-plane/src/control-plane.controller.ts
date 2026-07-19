import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  parseAcceptTurnRequest,
  parseCreateTenantRegistrationRequest,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseCreateTurnCancellationRequest,
  parseIdempotencyKey,
  parseLastEventIdHeader,
  parseUuidPathParameter,
  type AcceptedTurnResource,
  type AcceptedTurnCancellationResource,
  type ConversationDetailResource,
  type ConversationListResource,
  type ProjectResource,
  type SessionResource,
  type TenantIdentityResource,
  type TenantRegistrationResource,
} from "@agent-dock/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { PublicTenantRegistrationService } from "./public-tenant-registration.ts";
import { SessionEventStream } from "./session-event-stream.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";

@Controller("v1")
export class ControlPlaneController {
  constructor(
    @Inject(ControlPlaneStoreFactory) private readonly controlPlaneStores: ControlPlaneStoreFactory,
    @Inject(PublicTenantRegistrationService)
    private readonly publicTenantRegistration: PublicTenantRegistrationService,
    @Inject(TenantRequestContext) private readonly tenantRequestContext: TenantRequestContext,
    @Inject(SessionEventStream) private readonly sessionEventStream: SessionEventStream,
  ) {}

  @Post("registrations")
  async registerTenant(@Body() body: unknown): Promise<TenantRegistrationResource> {
    return this.publicTenantRegistration.register(parseCreateTenantRegistrationRequest(body));
  }

  @Get("identity")
  identity(@Req() request: FastifyRequest): TenantIdentityResource {
    const identity = this.tenantRequestContext.resolve(request);
    return {
      tenantId: identity.tenantId,
      tenantSlug: identity.tenantSlug,
      userId: identity.userId,
      displayName: identity.displayName,
      role: identity.role,
    };
  }

  @Post("projects")
  async createProject(
    @Req() httpRequest: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ProjectResource> {
    const request = parseCreateProjectRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores.forIdentity(identity).createProject(request.name);
  }

  @Get("conversations")
  async listConversations(@Req() request: FastifyRequest): Promise<ConversationListResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listConversations();
  }

  @Get("conversations/:sessionId")
  async getConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<ConversationDetailResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).getConversation(sessionId);
  }

  @Post("projects/:projectId/sessions")
  async createSession(
    @Req() httpRequest: FastifyRequest,
    @Param("projectId") projectIdValue: unknown,
    @Body() body: unknown,
  ): Promise<SessionResource> {
    const projectId = parseUuidPathParameter(projectIdValue, "projectId");
    const request = parseCreateSessionRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores
      .forIdentity(identity)
      .createSession(projectId, request.workspaceId);
  }

  @Post("sessions/:sessionId/turns")
  @HttpCode(202)
  async acceptTurn(
    @Req() httpRequest: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<AcceptedTurnResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const request = parseAcceptTurnRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores
      .forIdentity(identity)
      .acceptTurn(sessionId, idempotencyKey, request);
  }

  @Post("sessions/:sessionId/turns/:turnId/cancellations")
  @HttpCode(202)
  async acceptTurnCancellation(
    @Req() httpRequest: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Param("turnId") turnIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<AcceptedTurnCancellationResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const turnId = parseUuidPathParameter(turnIdValue, "turnId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const request = parseCreateTurnCancellationRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores
      .forIdentity(identity)
      .acceptTurnCancellation(sessionId, turnId, idempotencyKey, request);
  }

  @Get("sessions/:sessionId/events")
  async streamSessionEvents(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("last-event-id") lastEventIdValue: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const afterSequence = parseLastEventIdHeader(lastEventIdValue);
    const identity = this.tenantRequestContext.resolve(request);
    const stream = await this.sessionEventStream.open(identity.tenantId, sessionId, afterSequence);

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
