import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from "@nestjs/common";
import { ControlPlaneApiValidationError, type ControlPlaneApiError } from "@agent-dock/protocol";
import type { FastifyReply } from "fastify";
import { ControlPlaneStoreError } from "./control-plane-store.ts";

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
  if (error instanceof ControlPlaneStoreError) {
    const status =
      error.code === "invalid_request"
        ? 400
        : error.code === "not_found"
          ? 404
          : error.code === "conflict" || error.code === "idempotency_conflict"
            ? 409
            : 503;
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
