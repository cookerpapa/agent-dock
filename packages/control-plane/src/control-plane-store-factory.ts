import type { Database } from "@agent-dock/database";
import type { Kysely } from "kysely";
import { ControlPlaneStore } from "./control-plane-store.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

export class ControlPlaneStoreFactory {
  readonly #database: Kysely<Database>;
  readonly #idGenerator: (() => string) | undefined;
  readonly #environmentImageRevision: string | undefined;

  constructor(options: {
    database: Kysely<Database>;
    idGenerator?: () => string;
    environmentImageRevision?: string;
  }) {
    this.#database = options.database;
    this.#idGenerator = options.idGenerator;
    this.#environmentImageRevision = options.environmentImageRevision;
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
    });
  }
}
