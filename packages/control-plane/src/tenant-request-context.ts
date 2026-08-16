import type { FastifyRequest } from "fastify";
import { tenantRequestIdentity, type TenantRequestIdentity } from "./tenant-identity.ts";

export class TenantRequestContextError extends Error {
  readonly code: "authentication_required" | "authorization_denied";

  constructor(code: TenantRequestContextError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "TenantRequestContextError";
    this.code = code;
  }
}

export class TenantRequestContext {
  readonly #staticIdentity: TenantRequestIdentity | undefined;

  constructor(staticIdentity?: TenantRequestIdentity) {
    this.#staticIdentity = staticIdentity;
  }

  resolve(request: FastifyRequest): TenantRequestIdentity {
    const identity = tenantRequestIdentity(request) ?? this.#staticIdentity;
    if (identity === undefined) {
      throw new TenantRequestContextError(
        "authentication_required",
        "A valid PiCloud API credential is required",
      );
    }
    return identity;
  }

  requireMutation(request: FastifyRequest): TenantRequestIdentity {
    const identity = this.resolve(request);
    if (identity.role === "viewer") {
      throw new TenantRequestContextError(
        "authorization_denied",
        "This tenant role cannot mutate coding-session resources",
      );
    }
    return identity;
  }

  requireOwner(request: FastifyRequest): TenantRequestIdentity {
    const identity = this.resolve(request);
    if (identity.role !== "owner") {
      throw new TenantRequestContextError(
        "authorization_denied",
        "Only a tenant owner can administer external integrations",
      );
    }
    return identity;
  }
}
