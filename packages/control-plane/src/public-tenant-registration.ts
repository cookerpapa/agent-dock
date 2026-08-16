import type { Database } from "@pi-cloud/database";
import type {
  CreateTenantRegistrationRequest,
  TenantRegistrationResource,
} from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import {
  createPrivateTenant,
  TenantAdministrationError,
  type TenantQuotaConfiguration,
  type PrivateTenantInitialModel,
} from "./tenant-administration.ts";

export type PublicTenantRegistrationOptions = {
  database: Kysely<Database>;
  enabled: boolean;
  maximumTenants: number;
  tenantQuotas: TenantQuotaConfiguration;
  idGenerator?: () => string;
  randomSecret?: () => string;
  clock?: () => Date;
  initialModel?: PrivateTenantInitialModel;
};

export type PublicTenantRegistrationConfiguration = Omit<
  PublicTenantRegistrationOptions,
  "database"
>;

export type PublicTenantRegistrationErrorCode =
  "registration_disabled" | "tenant_slug_unavailable" | "registration_capacity_reached";

export class PublicTenantRegistrationError extends Error {
  readonly code: PublicTenantRegistrationErrorCode;

  constructor(code: PublicTenantRegistrationErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "PublicTenantRegistrationError";
    this.code = code;
  }
}

export class PublicTenantRegistrationService {
  readonly #options: PublicTenantRegistrationOptions;

  constructor(options: PublicTenantRegistrationOptions) {
    this.#options = options;
  }

  async register(request: CreateTenantRegistrationRequest): Promise<TenantRegistrationResource> {
    if (!this.#options.enabled) {
      throw new PublicTenantRegistrationError(
        "registration_disabled",
        "Self-service tenant registration is not enabled",
      );
    }
    try {
      const created = await createPrivateTenant(this.#options.database, {
        slug: request.tenantSlug,
        ownerDisplayName: request.displayName,
        ownerCredentialLabel: "self-service owner",
        quotas: this.#options.tenantQuotas,
        maximumTenants: this.#options.maximumTenants,
        ...(this.#options.idGenerator === undefined
          ? {}
          : { idGenerator: this.#options.idGenerator }),
        ...(this.#options.randomSecret === undefined
          ? {}
          : { randomSecret: this.#options.randomSecret }),
        ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
        ...(this.#options.initialModel === undefined
          ? {}
          : { initialModel: this.#options.initialModel }),
      });
      return {
        tenantId: created.tenantId,
        tenantSlug: created.tenantSlug,
        userId: created.ownerUserId,
        displayName: request.displayName,
        role: "owner",
        apiToken: created.credential.token,
      };
    } catch (error: unknown) {
      if (error instanceof TenantAdministrationError) {
        if (error.code === "tenant_conflict") {
          throw new PublicTenantRegistrationError(
            "tenant_slug_unavailable",
            "Tenant slug is unavailable",
          );
        }
        if (error.code === "tenant_capacity_reached") {
          throw new PublicTenantRegistrationError(
            "registration_capacity_reached",
            "Self-service tenant registration capacity has been reached",
          );
        }
      }
      throw error;
    }
  }
}
