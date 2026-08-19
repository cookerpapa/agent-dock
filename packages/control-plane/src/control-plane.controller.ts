import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  parseAcceptTurnRequest,
  parseLoginAccountRequest,
  parseRegisterAccountRequest,
  parseArchiveSessionRequest,
  parseCreateTenantRegistrationRequest,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseCreateTurnCancellationRequest,
  parseCreateTurnSteerRequest,
  parseCreateConversationForkRequest,
  parseCreateConversationPruneRequest,
  parseConversationTreeView,
  parseIdempotencyKey,
  parseLastEventIdHeader,
  parseReplaceModelConfigurationRequest,
  parseReplaceCubeProxyConfigurationRequest,
  parseUuidPathParameter,
  parseWorkspaceFileCursor,
  type AcceptedTurnResource,
  type AuthSessionResource,
  type AcceptedTurnCancellationResource,
  type TurnSteerResource,
  type ConversationDetailResource,
  type ConversationListResource,
  type ConversationTreeResource,
  type ConversationForkResource,
  type ConversationPruneResource,
  type ProjectResource,
  type ModelConfigurationResource,
  type CubeProxyConfigurationResource,
  type InternalCubeProxyConfigurationResource,
  type RunListResource,
  type RunResource,
  type SessionResource,
  type TenantIdentityResource,
  type TenantRegistrationResource,
  type LogoutResource,
  type WorkspaceFileListResource,
  type WorkspaceOperationResource,
  type WorkspaceVersionListResource,
  type WorkspaceVersionResource,
  type WorkspaceListResource,
  type WorkspaceDeletionResource,
} from "@pi-cloud/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { PublicTenantRegistrationService } from "./public-tenant-registration.ts";
import { SessionEventStream } from "@pi-cloud/runtime-core/session-event-stream";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { TenantModelConfigurationService } from "./tenant-model-configuration.ts";
import { WorkspaceVersionService } from "./workspace-version-service.ts";
import { readWebSessionCookie, WebAuthenticationService } from "./web-authentication.ts";
import { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";
import { TurnSteeringService } from "./turn-steering-service.ts";
import { ConversationTreeService } from "./conversation-tree-service.ts";

@Controller("v1")
export class ControlPlaneController {
  constructor(
    @Inject(ControlPlaneStoreFactory) private readonly controlPlaneStores: ControlPlaneStoreFactory,
    @Inject(PublicTenantRegistrationService)
    private readonly publicTenantRegistration: PublicTenantRegistrationService,
    @Inject(TenantRequestContext) private readonly tenantRequestContext: TenantRequestContext,
    @Inject(SessionEventStream) private readonly sessionEventStream: SessionEventStream,
    @Inject(TenantModelConfigurationService)
    private readonly tenantModelConfiguration: TenantModelConfigurationService,
    @Inject(WorkspaceVersionService)
    private readonly workspaceVersions: WorkspaceVersionService,
    @Inject(WebAuthenticationService)
    private readonly webAuthentication: WebAuthenticationService,
    @Inject(PlatformRuntimeSettingsService)
    private readonly platformRuntimeSettings: PlatformRuntimeSettingsService,
    @Inject(TurnSteeringService)
    private readonly turnSteering: TurnSteeringService,
    @Inject(ConversationTreeService)
    private readonly conversationTrees: ConversationTreeService,
  ) {}

  @Post("auth/register")
  async registerAccount(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSessionResource> {
    const issued = await this.webAuthentication.register(parseRegisterAccountRequest(body));
    reply.header("set-cookie", this.webAuthentication.cookie(issued));
    return issued.resource;
  }

  @Post("auth/login")
  @HttpCode(200)
  async loginAccount(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSessionResource> {
    const issued = await this.webAuthentication.login(parseLoginAccountRequest(body));
    reply.header("set-cookie", this.webAuthentication.cookie(issued));
    return issued.resource;
  }

  @Post("auth/logout")
  @HttpCode(200)
  async logoutAccount(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogoutResource> {
    await this.webAuthentication.logout(readWebSessionCookie(request.headers.cookie));
    reply.header("set-cookie", this.webAuthentication.clearCookie());
    return { loggedOut: true };
  }

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
      platformAdministrator: this.platformRuntimeSettings.isPlatformAdministrator(identity),
    };
  }

  @Get("model-configuration")
  async getModelConfiguration(@Req() request: FastifyRequest): Promise<ModelConfigurationResource> {
    return this.tenantModelConfiguration.get(this.tenantRequestContext.resolve(request));
  }

  @Put("model-configuration")
  async replaceModelConfiguration(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ModelConfigurationResource> {
    return this.tenantModelConfiguration.replace(
      this.tenantRequestContext.resolve(request),
      parseReplaceModelConfigurationRequest(body),
    );
  }

  @Get("platform-settings/cube-proxy")
  async getCubeProxyConfiguration(
    @Req() request: FastifyRequest,
  ): Promise<CubeProxyConfigurationResource> {
    return this.platformRuntimeSettings.get(this.tenantRequestContext.resolve(request));
  }

  @Put("platform-settings/cube-proxy")
  async replaceCubeProxyConfiguration(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CubeProxyConfigurationResource> {
    return this.platformRuntimeSettings.replace(
      this.tenantRequestContext.resolve(request),
      parseReplaceCubeProxyConfigurationRequest(body),
    );
  }

  @Get("internal/cube-egress-configuration")
  async internalCubeEgressConfiguration(
    @Headers("x-pi-cloud-internal-token") token: string | undefined,
  ): Promise<InternalCubeProxyConfigurationResource> {
    return this.platformRuntimeSettings.internal(token);
  }

  @Post("projects")
  async createProject(
    @Req() httpRequest: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ProjectResource> {
    const request = parseCreateProjectRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores.forIdentity(identity).createProject(request);
  }

  @Get("conversations")
  async listConversations(@Req() request: FastifyRequest): Promise<ConversationListResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listConversations();
  }

  @Get("workspaces")
  async listWorkspaces(@Req() request: FastifyRequest): Promise<WorkspaceListResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listWorkspaces();
  }

  @Delete("workspaces/:workspaceId")
  async deleteWorkspace(
    @Req() request: FastifyRequest,
    @Param("workspaceId") workspaceIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
  ): Promise<WorkspaceDeletionResource> {
    const workspaceId = parseUuidPathParameter(workspaceIdValue, "workspaceId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.controlPlaneStores
      .forIdentity(identity)
      .deleteWorkspace(workspaceId, parseIdempotencyKey(idempotencyKeyValue));
  }

  @Delete("conversations/:sessionId")
  async deleteConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
  ): Promise<WorkspaceOperationResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.workspaceVersions.archive(
      identity.tenantId,
      parseIdempotencyKey(idempotencyKeyValue),
      sessionId,
      { archived: true },
    );
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

  @Get("conversations/:sessionId/tree")
  async getConversationTree(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Query("view") viewValue: unknown,
  ): Promise<ConversationTreeResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.conversationTrees.tree(
      identity.tenantId,
      sessionId,
      parseConversationTreeView(viewValue),
    );
  }

  @Post("conversations/:sessionId/forks")
  async forkConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<ConversationForkResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.conversationTrees.fork(
      identity.tenantId,
      sessionId,
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateConversationForkRequest(body),
    );
  }

  @Post("conversations/:sessionId/prunes")
  async pruneConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<ConversationPruneResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.conversationTrees.prune(
      identity.tenantId,
      sessionId,
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateConversationPruneRequest(body),
    );
  }

  @Get("sessions/:sessionId/runs")
  async listRuns(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<RunListResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listRuns(sessionId);
  }

  @Get("runs/:runId")
  async getRun(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
  ): Promise<RunResource> {
    const runId = parseUuidPathParameter(runIdValue, "runId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).getRun(runId);
  }

  @Get("sessions/:sessionId/workspace-versions")
  async listWorkspaceVersions(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<WorkspaceVersionListResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.workspaceVersions.list(identity.tenantId, sessionId);
  }

  @Get("workspace-versions/:versionId")
  async getWorkspaceVersion(
    @Req() request: FastifyRequest,
    @Param("versionId") versionIdValue: unknown,
  ): Promise<WorkspaceVersionResource> {
    const versionId = parseUuidPathParameter(versionIdValue, "versionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.workspaceVersions.get(identity.tenantId, versionId);
  }

  @Get("workspace-versions/:versionId/files")
  async listWorkspaceFiles(
    @Req() request: FastifyRequest,
    @Param("versionId") versionIdValue: unknown,
    @Query("cursor") cursorValue: unknown,
  ): Promise<WorkspaceFileListResource> {
    const versionId = parseUuidPathParameter(versionIdValue, "versionId");
    const cursor = parseWorkspaceFileCursor(cursorValue);
    const identity = this.tenantRequestContext.resolve(request);
    return this.workspaceVersions.files(identity.tenantId, versionId, cursor);
  }

  @Get("workspace-versions/:versionId/file")
  async readWorkspaceFile(
    @Req() request: FastifyRequest,
    @Param("versionId") versionIdValue: unknown,
    @Query("path") path: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const versionId = parseUuidPathParameter(versionIdValue, "versionId");
    if (typeof path !== "string") throw new TypeError("Workspace file path is required");
    const identity = this.tenantRequestContext.resolve(request);
    const file = await this.workspaceVersions.file(identity.tenantId, versionId, path);
    reply
      .header("cache-control", "private, no-store")
      .header("content-type", "application/octet-stream")
      .header("etag", `"${file.sha256}"`)
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(file.bytes));
  }

  @Post("sessions/:sessionId/archive")
  async archiveSession(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<WorkspaceOperationResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.workspaceVersions.archive(
      identity.tenantId,
      idempotencyKey,
      sessionId,
      parseArchiveSessionRequest(body),
    );
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
      .createSession(projectId, request.workspaceId, request.title, request.sandboxRetention);
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

  @Post("sessions/:sessionId/turns/:turnId/steers")
  @HttpCode(200)
  async steerTurn(
    @Req() httpRequest: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Param("turnId") turnIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<TurnSteerResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const turnId = parseUuidPathParameter(turnIdValue, "turnId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const request = parseCreateTurnSteerRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.turnSteering.deliver(identity, sessionId, turnId, idempotencyKey, request);
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
