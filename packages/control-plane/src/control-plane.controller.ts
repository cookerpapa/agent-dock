import {
  Body,
  Controller,
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
  parseArchiveSessionRequest,
  parseCreateTenantRegistrationRequest,
  parseCreateGitHubPullRequestRequest,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseCreateTurnCancellationRequest,
  parseIdempotencyKey,
  parseForkSessionRequest,
  parseLastEventIdHeader,
  parsePositiveIntegerPathParameter,
  parseRegisterGitHubInstallationRequest,
  parseReplaceModelConfigurationRequest,
  parseRollbackWorkspaceRequest,
  parseSetGitHubRepositoryRequest,
  parseUuidPathParameter,
  type AcceptedTurnResource,
  type AcceptedTurnCancellationResource,
  type ConversationDetailResource,
  type ConversationListResource,
  type GitHubInstallationResource,
  type GitHubPullRequestDeliveryResource,
  type ProjectResource,
  type ModelConfigurationResource,
  type RunListResource,
  type RunResource,
  type SessionResource,
  type TenantIdentityResource,
  type TenantRegistrationResource,
  type TestResultListResource,
  type WorkspaceFileListResource,
  type WorkspaceOperationResource,
  type WorkspaceVersionCompareResource,
  type WorkspaceVersionListResource,
  type WorkspaceVersionResource,
} from "@agent-dock/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { GitHubIntegrationService } from "./github-integration-service.ts";
import { PublicTenantRegistrationService } from "./public-tenant-registration.ts";
import { SessionEventStream } from "./session-event-stream.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { TenantModelConfigurationService } from "./tenant-model-configuration.ts";
import { WorkspaceVersionService } from "./workspace-version-service.ts";

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
    @Inject(GitHubIntegrationService)
    private readonly githubIntegration: GitHubIntegrationService,
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

  @Get("conversations/:sessionId")
  async getConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<ConversationDetailResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).getConversation(sessionId);
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

  @Get("runs/:runId/test-results")
  async listRunTestResults(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
  ): Promise<TestResultListResource> {
    const runId = parseUuidPathParameter(runIdValue, "runId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listTestResults(runId);
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
  ): Promise<WorkspaceFileListResource> {
    const versionId = parseUuidPathParameter(versionIdValue, "versionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.workspaceVersions.files(identity.tenantId, versionId);
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

  @Get("workspace-versions/:baseVersionId/compare/:targetVersionId")
  async compareWorkspaceVersions(
    @Req() request: FastifyRequest,
    @Param("baseVersionId") baseVersionIdValue: unknown,
    @Param("targetVersionId") targetVersionIdValue: unknown,
  ): Promise<WorkspaceVersionCompareResource> {
    const baseVersionId = parseUuidPathParameter(baseVersionIdValue, "baseVersionId");
    const targetVersionId = parseUuidPathParameter(targetVersionIdValue, "targetVersionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.workspaceVersions.compare(identity.tenantId, baseVersionId, targetVersionId);
  }

  @Get("artifacts/:artifactId/content")
  async readArtifact(
    @Req() request: FastifyRequest,
    @Param("artifactId") artifactIdValue: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const artifactId = parseUuidPathParameter(artifactIdValue, "artifactId");
    const identity = this.tenantRequestContext.resolve(request);
    const artifact = await this.workspaceVersions.artifact(identity.tenantId, artifactId);
    reply
      .header("cache-control", "private, no-store")
      .header("content-type", artifact.resource.mediaType ?? "application/octet-stream")
      .header("etag", `"${artifact.resource.sha256}"`)
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(artifact.bytes));
  }

  @Post("sessions/:sessionId/forks")
  async forkSession(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<WorkspaceOperationResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.workspaceVersions.fork(
      identity.tenantId,
      idempotencyKey,
      sessionId,
      parseForkSessionRequest(body),
    );
  }

  @Post("sessions/:sessionId/workspace-rollback")
  async rollbackWorkspace(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<WorkspaceOperationResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.workspaceVersions.rollback(
      identity.tenantId,
      idempotencyKey,
      sessionId,
      parseRollbackWorkspaceRequest(body),
    );
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

  @Post("github/installations")
  async registerGitHubInstallation(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<GitHubInstallationResource> {
    const identity = this.tenantRequestContext.requireOwner(request);
    const input = parseRegisterGitHubInstallationRequest(body);
    return this.githubIntegration.registerInstallation(identity.tenantId, input.installationId);
  }

  @Get("github/installations/:installationId")
  async getGitHubInstallation(
    @Req() request: FastifyRequest,
    @Param("installationId") installationIdValue: unknown,
  ): Promise<GitHubInstallationResource> {
    const identity = this.tenantRequestContext.resolve(request);
    const installationId = parsePositiveIntegerPathParameter(installationIdValue, "installationId");
    return this.githubIntegration.getInstallation(identity.tenantId, installationId);
  }

  @Put("github/installations/:installationId/repositories/:repositoryId")
  async setGitHubRepository(
    @Req() request: FastifyRequest,
    @Param("installationId") installationIdValue: unknown,
    @Param("repositoryId") repositoryIdValue: unknown,
    @Body() body: unknown,
  ): Promise<GitHubInstallationResource> {
    const identity = this.tenantRequestContext.requireOwner(request);
    const installationId = parsePositiveIntegerPathParameter(installationIdValue, "installationId");
    const repositoryId = parsePositiveIntegerPathParameter(repositoryIdValue, "repositoryId");
    const input = parseSetGitHubRepositoryRequest(body);
    return this.githubIntegration.setRepositoryEnabled(
      identity.tenantId,
      installationId,
      repositoryId,
      input.enabled,
    );
  }

  @Post("workspace-versions/:versionId/pull-requests")
  async createGitHubPullRequest(
    @Req() request: FastifyRequest,
    @Param("versionId") versionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<GitHubPullRequestDeliveryResource> {
    const identity = this.tenantRequestContext.requireMutation(request);
    const versionId = parseUuidPathParameter(versionIdValue, "versionId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    return this.githubIntegration.deliverPullRequest(
      identity.tenantId,
      versionId,
      idempotencyKey,
      parseCreateGitHubPullRequestRequest(body),
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
