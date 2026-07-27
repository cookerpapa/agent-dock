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
  parseActivateProjectEnvironmentVersionRequest,
  parseCreateProjectEnvironmentVersionRequest,
  parseLoginAccountRequest,
  parseRegisterAccountRequest,
  parseArchiveSessionRequest,
  parseCreateCandidateRaceRequest,
  parseCreateTenantRegistrationRequest,
  parseCreateGitHubPullRequestRequest,
  parseCreateProjectRequest,
  parseCreateRunRewindRequest,
  parseCreateSessionRequest,
  parseCreateTurnCancellationRequest,
  parseIdempotencyKey,
  parseForkSessionRequest,
  parseLastEventIdHeader,
  parsePositiveIntegerPathParameter,
  parsePromoteCandidateRequest,
  parseRegisterGitHubInstallationRequest,
  parseReplaceModelConfigurationRequest,
  parseReplaceCubeProxyConfigurationRequest,
  parseReplaceModelGovernanceRequest,
  parseRollbackWorkspaceRequest,
  parseSetGitHubRepositoryRequest,
  parseUuidPathParameter,
  type AcceptedTurnResource,
  type AuthSessionResource,
  type AcceptedTurnCancellationResource,
  type CandidateRaceListResource,
  type CandidateRaceResource,
  type ConversationDetailResource,
  type ConversationListResource,
  type GitHubInstallationResource,
  type GitHubPullRequestDeliveryResource,
  type ProjectResource,
  type ProjectEnvironmentHistoryResource,
  type ModelConfigurationResource,
  type CubeProxyConfigurationResource,
  type InternalCubeProxyConfigurationResource,
  type ModelGovernanceResource,
  type OperationalAuditLogResource,
  type OperationalInsightsResource,
  type RunUsageResource,
  type RunRewindResource,
  type ReviewBundleResource,
  type SessionContextResource,
  type UsageSummaryResource,
  type RunListResource,
  type RunResource,
  type SessionResource,
  type TenantIdentityResource,
  type TenantRegistrationResource,
  type LogoutResource,
  type TestResultListResource,
  type WorkspaceFileListResource,
  type WorkspaceOperationResource,
  type WorkspaceVersionCompareResource,
  type WorkspaceVersionListResource,
  type WorkspaceVersionResource,
  type WorkspaceListResource,
} from "@agent-dock/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { GitHubIntegrationService } from "./github-integration-service.ts";
import { PublicTenantRegistrationService } from "./public-tenant-registration.ts";
import { SessionEventStream } from "./session-event-stream.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { TenantModelConfigurationService } from "./tenant-model-configuration.ts";
import { WorkspaceVersionService } from "./workspace-version-service.ts";
import { ModelGovernanceService } from "./model-governance-service.ts";
import { OperationalInsightsService } from "./operational-insights-service.ts";
import { readWebSessionCookie, WebAuthenticationService } from "./web-authentication.ts";
import { ProjectEnvironmentService } from "./project-environment-service.ts";
import { CandidateRaceService } from "./candidate-race-service.ts";
import { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";

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
    @Inject(ModelGovernanceService)
    private readonly modelGovernance: ModelGovernanceService,
    @Inject(OperationalInsightsService)
    private readonly operationalInsights: OperationalInsightsService,
    @Inject(WorkspaceVersionService)
    private readonly workspaceVersions: WorkspaceVersionService,
    @Inject(GitHubIntegrationService)
    private readonly githubIntegration: GitHubIntegrationService,
    @Inject(WebAuthenticationService)
    private readonly webAuthentication: WebAuthenticationService,
    @Inject(ProjectEnvironmentService)
    private readonly projectEnvironments: ProjectEnvironmentService,
    @Inject(CandidateRaceService)
    private readonly candidateRaces: CandidateRaceService,
    @Inject(PlatformRuntimeSettingsService)
    private readonly platformRuntimeSettings: PlatformRuntimeSettingsService,
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
    @Headers("x-agent-dock-internal-token") token: string | undefined,
  ): Promise<InternalCubeProxyConfigurationResource> {
    return this.platformRuntimeSettings.internal(token);
  }

  @Get("model-governance")
  async getModelGovernance(@Req() request: FastifyRequest): Promise<ModelGovernanceResource> {
    return this.modelGovernance.get(this.tenantRequestContext.resolve(request));
  }

  @Put("model-governance")
  async replaceModelGovernance(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ModelGovernanceResource> {
    return this.modelGovernance.replace(
      this.tenantRequestContext.resolve(request),
      parseReplaceModelGovernanceRequest(body),
    );
  }

  @Get("usage")
  async getUsage(@Req() request: FastifyRequest): Promise<UsageSummaryResource> {
    return this.modelGovernance.usage(this.tenantRequestContext.resolve(request));
  }

  @Get("operations/summary")
  async getOperationalInsights(
    @Req() request: FastifyRequest,
  ): Promise<OperationalInsightsResource> {
    return this.operationalInsights.get(this.tenantRequestContext.requireOwner(request));
  }

  @Get("operations/audit")
  async getOperationalAudit(@Req() request: FastifyRequest): Promise<OperationalAuditLogResource> {
    return this.operationalInsights.audit(this.tenantRequestContext.requireOwner(request));
  }

  @Get("projects/:projectId/environments")
  async getProjectEnvironments(
    @Req() request: FastifyRequest,
    @Param("projectId") projectIdValue: unknown,
  ): Promise<ProjectEnvironmentHistoryResource> {
    return this.projectEnvironments.history(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(projectIdValue, "projectId"),
    );
  }

  @Post("projects/:projectId/environments")
  async createProjectEnvironment(
    @Req() request: FastifyRequest,
    @Param("projectId") projectIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<ProjectEnvironmentHistoryResource> {
    return this.projectEnvironments.createVersion(
      this.tenantRequestContext.requireOwner(request),
      parseUuidPathParameter(projectIdValue, "projectId"),
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateProjectEnvironmentVersionRequest(body),
    );
  }

  @Post("projects/:projectId/environments/:environmentVersionId/activate")
  async activateProjectEnvironment(
    @Req() request: FastifyRequest,
    @Param("projectId") projectIdValue: unknown,
    @Param("environmentVersionId") environmentVersionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<ProjectEnvironmentHistoryResource> {
    return this.projectEnvironments.activateVersion(
      this.tenantRequestContext.requireOwner(request),
      parseUuidPathParameter(projectIdValue, "projectId"),
      parseUuidPathParameter(environmentVersionIdValue, "environmentVersionId"),
      parseIdempotencyKey(idempotencyKeyValue),
      parseActivateProjectEnvironmentVersionRequest(body),
    );
  }

  @Post("sessions/:sessionId/environments/:environmentVersionId/validate")
  async validateProjectEnvironment(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Param("environmentVersionId") environmentVersionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
  ): Promise<AcceptedTurnResource> {
    const identity = this.tenantRequestContext.requireOwner(request);
    return this.controlPlaneStores
      .forIdentity(identity)
      .acceptEnvironmentValidationTurn(
        parseUuidPathParameter(sessionIdValue, "sessionId"),
        parseUuidPathParameter(environmentVersionIdValue, "environmentVersionId"),
        identity.userId,
        parseIdempotencyKey(idempotencyKeyValue),
      );
  }

  @Get("runs/:runId/usage")
  async getRunUsage(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
  ): Promise<RunUsageResource> {
    return this.modelGovernance.runUsage(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(runIdValue, "runId"),
    );
  }

  @Get("sessions/:sessionId/context")
  async getSessionContext(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<SessionContextResource> {
    return this.modelGovernance.sessionContext(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(sessionIdValue, "sessionId"),
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

  @Get("workspaces")
  async listWorkspaces(@Req() request: FastifyRequest): Promise<WorkspaceListResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listWorkspaces();
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

  @Get("sessions/:sessionId/runs")
  async listRuns(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<RunListResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listRuns(sessionId);
  }

  @Post("sessions/:sessionId/candidate-races")
  @HttpCode(202)
  async createCandidateRace(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<CandidateRaceResource> {
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.candidateRaces.create(
      identity,
      parseUuidPathParameter(sessionIdValue, "sessionId"),
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateCandidateRaceRequest(body),
    );
  }

  @Get("sessions/:sessionId/candidate-races")
  async listCandidateRaces(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<CandidateRaceListResource> {
    return this.candidateRaces.list(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(sessionIdValue, "sessionId"),
    );
  }

  @Get("candidate-races/:orchestrationId")
  async getCandidateRace(
    @Req() request: FastifyRequest,
    @Param("orchestrationId") orchestrationIdValue: unknown,
  ): Promise<CandidateRaceResource> {
    return this.candidateRaces.get(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(orchestrationIdValue, "orchestrationId"),
    );
  }

  @Post("candidate-races/:orchestrationId/cancellation")
  @HttpCode(202)
  async cancelCandidateRace(
    @Req() request: FastifyRequest,
    @Param("orchestrationId") orchestrationIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
  ): Promise<CandidateRaceResource> {
    return this.candidateRaces.cancel(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(orchestrationIdValue, "orchestrationId"),
      parseIdempotencyKey(idempotencyKeyValue),
    );
  }

  @Post("candidate-races/:orchestrationId/promotion")
  async promoteCandidateRace(
    @Req() request: FastifyRequest,
    @Param("orchestrationId") orchestrationIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<CandidateRaceResource> {
    return this.candidateRaces.promote(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(orchestrationIdValue, "orchestrationId"),
      parseIdempotencyKey(idempotencyKeyValue),
      parsePromoteCandidateRequest(body),
    );
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

  @Post("runs/:runId/rewinds")
  @HttpCode(202)
  async rewindRun(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<RunRewindResource> {
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.controlPlaneStores
      .forIdentity(identity)
      .acceptRunRewind(
        parseUuidPathParameter(runIdValue, "runId"),
        parseIdempotencyKey(idempotencyKeyValue),
        parseCreateRunRewindRequest(body),
        identity.userId,
      );
  }

  @Get("runs/:runId/review-bundle")
  async getRunReviewBundle(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
  ): Promise<ReviewBundleResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores
      .forIdentity(identity)
      .getReviewBundle(parseUuidPathParameter(runIdValue, "runId"));
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
      .createSession(projectId, request.workspaceId, request.title);
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
