import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import {
  parseAcceptTurnRequest,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseIdempotencyKey,
  parseUuidPathParameter,
  type AcceptedTurnResource,
  type ProjectResource,
  type SessionResource,
} from "@agent-dock/protocol";
import { ControlPlaneStore } from "./control-plane-store.ts";

export const CONTROL_PLANE_STORE = Symbol("CONTROL_PLANE_STORE");

@Controller("v1")
export class ControlPlaneController {
  constructor(@Inject(CONTROL_PLANE_STORE) private readonly controlPlaneStore: ControlPlaneStore) {}

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
}
