import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { ControlPlaneStore } from "./control-plane-store.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import type { PiCloudMetrics } from "@pi-cloud/observability";

export class ControlPlaneStoreFactory {
  readonly #database: Kysely<Database>;
  readonly #idGenerator: (() => string) | undefined;
  readonly #environmentImageRevision: string | undefined;
  readonly #metrics: PiCloudMetrics | undefined;

  constructor(options: {
    database: Kysely<Database>;
    idGenerator?: () => string;
    environmentImageRevision?: string;
    metrics?: PiCloudMetrics;
  }) {
    this.#database = options.database;
    this.#idGenerator = options.idGenerator;
    this.#environmentImageRevision = options.environmentImageRevision;
    this.#metrics = options.metrics;
  }

  forIdentity(identity: TenantRequestIdentity): ControlPlaneStore {
    return new ControlPlaneStore({
      database: this.#database,
      tenantId: identity.tenantId,
      defaultModelProfileId: identity.defaultModelProfileId,
      ...(this.#environmentImageRevision === undefined
        ? {}
        : { environmentImageRevision: this.#environmentImageRevision }),
      ...(this.#idGenerator === undefined ? {} : { idGenerator: this.#idGenerator }),
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    });
  }
}
