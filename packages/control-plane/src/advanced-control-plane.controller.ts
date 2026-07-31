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
  Req,
} from "@nestjs/common";
import {
  parseActivateProjectEnvironmentVersionRequest,
  parseCreateCandidateRaceRequest,
  parseCreateProjectEnvironmentVersionRequest,
  parseCreateRunRewindRequest,
  parseIdempotencyKey,
  parsePromoteCandidateRequest,
  parseReplaceModelGovernanceRequest,
  parseUuidPathParameter,
  type AcceptedTurnResource,
  type CandidateRaceListResource,
  type CandidateRaceResource,
  type ModelGovernanceResource,
  type OperationalAuditLogResource,
  type OperationalInsightsResource,
  type ProjectEnvironmentHistoryResource,
  type ReviewBundleResource,
  type RunRewindResource,
  type RunUsageResource,
  type SessionContextResource,
  type UsageSummaryResource,
} from "@agent-dock/protocol";
import type { FastifyRequest } from "fastify";
import { CandidateRaceService } from "./candidate-race-service.ts";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { ModelGovernanceService } from "./model-governance-service.ts";
import { OperationalInsightsService } from "./operational-insights-service.ts";
import { ProjectEnvironmentService } from "./project-environment-service.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";

/** Optional research/operations API. The core chat product does not register it. */
@Controller("v1")
export class AdvancedControlPlaneController {
  constructor(
    @Inject(ControlPlaneStoreFactory) private readonly controlPlaneStores: ControlPlaneStoreFactory,
    @Inject(TenantRequestContext) private readonly tenantRequestContext: TenantRequestContext,
    @Inject(ModelGovernanceService) private readonly modelGovernance: ModelGovernanceService,
    @Inject(OperationalInsightsService)
    private readonly operationalInsights: OperationalInsightsService,
    @Inject(ProjectEnvironmentService)
    private readonly projectEnvironments: ProjectEnvironmentService,
    @Inject(CandidateRaceService) private readonly candidateRaces: CandidateRaceService,
  ) {}

  @Get("model-governance")
  getModelGovernance(@Req() request: FastifyRequest): Promise<ModelGovernanceResource> {
    return this.modelGovernance.get(this.tenantRequestContext.resolve(request));
  }

  @Put("model-governance")
  replaceModelGovernance(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ModelGovernanceResource> {
    return this.modelGovernance.replace(
      this.tenantRequestContext.resolve(request),
      parseReplaceModelGovernanceRequest(body),
    );
  }

  @Get("usage")
  getUsage(@Req() request: FastifyRequest): Promise<UsageSummaryResource> {
    return this.modelGovernance.usage(this.tenantRequestContext.resolve(request));
  }

  @Get("operations/summary")
  getOperationalInsights(@Req() request: FastifyRequest): Promise<OperationalInsightsResource> {
    return this.operationalInsights.get(this.tenantRequestContext.requireOwner(request));
  }

  @Get("operations/audit")
  getOperationalAudit(@Req() request: FastifyRequest): Promise<OperationalAuditLogResource> {
    return this.operationalInsights.audit(this.tenantRequestContext.requireOwner(request));
  }

  @Get("projects/:projectId/environments")
  getProjectEnvironments(
    @Req() request: FastifyRequest,
    @Param("projectId") projectIdValue: unknown,
  ): Promise<ProjectEnvironmentHistoryResource> {
    return this.projectEnvironments.history(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(projectIdValue, "projectId"),
    );
  }

  @Post("projects/:projectId/environments")
  createProjectEnvironment(
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
  activateProjectEnvironment(
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
  validateProjectEnvironment(
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
  getRunUsage(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
  ): Promise<RunUsageResource> {
    return this.modelGovernance.runUsage(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(runIdValue, "runId"),
    );
  }

  @Get("sessions/:sessionId/context")
  getSessionContext(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<SessionContextResource> {
    return this.modelGovernance.sessionContext(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(sessionIdValue, "sessionId"),
    );
  }

  @Post("sessions/:sessionId/candidate-races")
  @HttpCode(202)
  createCandidateRace(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<CandidateRaceResource> {
    return this.candidateRaces.create(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(sessionIdValue, "sessionId"),
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateCandidateRaceRequest(body),
    );
  }

  @Get("sessions/:sessionId/candidate-races")
  listCandidateRaces(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<CandidateRaceListResource> {
    return this.candidateRaces.list(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(sessionIdValue, "sessionId"),
    );
  }

  @Get("candidate-races/:orchestrationId")
  getCandidateRace(
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
  cancelCandidateRace(
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
  promoteCandidateRace(
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

  @Post("runs/:runId/rewinds")
  @HttpCode(202)
  rewindRun(
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
  getRunReviewBundle(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
  ): Promise<ReviewBundleResource> {
    return this.controlPlaneStores
      .forIdentity(this.tenantRequestContext.resolve(request))
      .getReviewBundle(parseUuidPathParameter(runIdValue, "runId"));
  }
}
