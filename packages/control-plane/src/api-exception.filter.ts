import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from "@nestjs/common";
import { ControlPlaneApiValidationError, type ControlPlaneApiError } from "@agent-dock/protocol";
import type { FastifyReply } from "fastify";
import { ControlPlaneStoreError } from "./control-plane-store.ts";
import { DurableEventStoreError } from "./durable-event-store.ts";
import { PublicTenantRegistrationError } from "./public-tenant-registration.ts";
import { TenantRequestContextError } from "./tenant-request-context.ts";
import { TenantModelConfigurationError } from "./tenant-model-configuration.ts";
import { WorkspaceVersionError } from "./workspace-version-service.ts";
import { GitHubIntegrationError } from "./github-integration-service.ts";
import { ModelGovernanceError } from "./model-governance-service.ts";

type ErrorResponse = {
  status: number;
  body: ControlPlaneApiError;
};

function mappedError(error: unknown): ErrorResponse {
  if (error instanceof ControlPlaneApiValidationError) {
    return {
      status: 400,
      body: { error: { code: "invalid_request", message: error.message } },
    };
  }
  if (error instanceof TenantRequestContextError) {
    return {
      status: error.code === "authentication_required" ? 401 : 403,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof TenantModelConfigurationError) {
    return {
      status: error.code === "authorization_denied" ? 403 : 503,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof ModelGovernanceError) {
    const status =
      error.code === "authorization_denied"
        ? 403
        : error.code === "not_found"
          ? 404
          : error.code === "invalid_request"
            ? 400
            : 503;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof PublicTenantRegistrationError) {
    const status =
      error.code === "registration_disabled"
        ? 404
        : error.code === "tenant_slug_unavailable"
          ? 409
          : 429;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof ControlPlaneStoreError) {
    const status =
      error.code === "invalid_request"
        ? 400
        : error.code === "not_found"
          ? 404
          : error.code === "tenant_quota_exceeded"
            ? 429
            : error.code === "conflict" || error.code === "idempotency_conflict"
              ? 409
              : 503;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof WorkspaceVersionError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "conflict" || error.code === "idempotency_conflict"
          ? 409
          : error.code === "tenant_quota_exceeded"
            ? 429
            : 503;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof GitHubIntegrationError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "idempotency_conflict" || error.code === "conflict"
          ? 409
          : error.code === "github_app_not_configured" || error.retryable
            ? 503
            : 502;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof DurableEventStoreError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "cursor_ahead" || error.code === "event_conflict"
          ? 409
          : error.code === "event_store_invariant"
            ? 503
            : 400;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status >= 500) {
      return {
        status,
        body: {
          error: {
            code: "internal_error",
            message: "The control plane could not complete the request",
          },
        },
      };
    }
    return {
      status,
      body: {
        error: {
          code: status === 404 ? "route_not_found" : "invalid_request",
          message:
            status === 404 ? "The requested API route was not found" : "Invalid HTTP request",
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "The control plane could not complete the request",
      },
    },
  };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = mappedError(error);
    host.switchToHttp().getResponse<FastifyReply>().status(response.status).send(response.body);
  }
}
