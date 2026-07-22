import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { EnvironmentRecipe } from "@agent-dock/protocol";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ControlPlaneStoreError,
  ProjectEnvironmentService,
  createPrivateTenant,
  type TenantRequestIdentity,
} from "../src/index.ts";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ACTIVE_ENVIRONMENT_ID = "20000000-0000-4000-8000-000000000001";
const CANDIDATE_ENVIRONMENT_ID = "30000000-0000-4000-8000-000000000001";
const GENERATED_IDS = [
  CANDIDATE_ENVIRONMENT_ID,
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "40000000-0000-4000-8000-000000000003",
] as const;

const candidateRecipe: EnvironmentRecipe = {
  schemaVersion: 1,
  setupCommands: [
    {
      id: "prepare-node",
      command: "node --version > .agent-dock-node-version",
      cwd: ".",
      timeoutMs: 10_000,
      network: "none",
    },
  ],
  verificationCommands: [
    {
      id: "verify-node",
      command: "test -s .agent-dock-node-version",
      cwd: ".",
      timeoutMs: 10_000,
      network: "none",
    },
  ],
};

let postgres: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let identity: TenantRequestIdentity;
let service: ProjectEnvironmentService;

beforeAll(async () => {
  postgres = await PGlite.create();
  socket = new PGLiteSocketServer({
    db: postgres,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: "environment-service",
    ownerDisplayName: "Environment Owner",
  });
  identity = {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: "Environment Owner",
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
  await database
    .insertInto("projects")
    .values({ id: PROJECT_ID, tenant_id: identity.tenantId, name: "Environment project" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("environment_versions")
    .values({
      id: ACTIVE_ENVIRONMENT_ID,
      tenant_id: identity.tenantId,
      project_id: PROJECT_ID,
      version_number: 1,
      profile_key: "agent-dock-fullstack",
      profile_version: "1",
      image_revision: "development",
      spec_sha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      state: "validated",
      active: true,
      validated_at: new Date("2026-07-22T00:00:00.000Z"),
    })
    .executeTakeFirstOrThrow();
  let generatedIndex = 0;
  service = new ProjectEnvironmentService({
    database,
    imageRevision: "development",
    idGenerator: () => GENERATED_IDS[generatedIndex++]!,
  });
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await postgres?.close();
});

describe.sequential("project environment configuration as code", () => {
  it("creates one immutable pending candidate and replays the same idempotent request", async () => {
    const created = await service.createVersion(identity, PROJECT_ID, "create-candidate", {
      recipe: candidateRecipe,
    });
    expect(created).toMatchObject({
      activeEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID,
      versions: [
        {
          environmentVersionId: CANDIDATE_ENVIRONMENT_ID,
          versionNumber: 2,
          state: "pending",
          active: false,
          recipe: candidateRecipe,
        },
        { environmentVersionId: ACTIVE_ENVIRONMENT_ID, active: true },
      ],
      operations: [
        {
          kind: "create",
          fromEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID,
          toEnvironmentVersionId: CANDIDATE_ENVIRONMENT_ID,
        },
      ],
    });
    await expect(
      service.createVersion(identity, PROJECT_ID, "create-candidate", { recipe: candidateRecipe }),
    ).resolves.toMatchObject({ activeEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID });
    expect(
      await database
        .selectFrom("environment_operations")
        .select("id")
        .where("project_id", "=", PROJECT_ID)
        .where("kind", "=", "create")
        .execute(),
    ).toHaveLength(1);
    await expect(
      service.createVersion(identity, PROJECT_ID, "create-candidate", {
        recipe: {
          ...candidateRecipe,
          setupCommands: [],
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("refuses an unvalidated candidate, then activates and rolls back with compare-and-swap", async () => {
    await expect(
      service.activateVersion(identity, PROJECT_ID, CANDIDATE_ENVIRONMENT_ID, "activate-pending", {
        expectedActiveEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await database
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date("2026-07-22T00:01:00.000Z") })
      .where("id", "=", CANDIDATE_ENVIRONMENT_ID)
      .executeTakeFirstOrThrow();
    const activated = await service.activateVersion(
      identity,
      PROJECT_ID,
      CANDIDATE_ENVIRONMENT_ID,
      "activate-candidate",
      { expectedActiveEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID },
    );
    expect(activated.activeEnvironmentVersionId).toBe(CANDIDATE_ENVIRONMENT_ID);
    expect(activated.operations[0]).toMatchObject({
      kind: "activate",
      fromEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID,
      toEnvironmentVersionId: CANDIDATE_ENVIRONMENT_ID,
    });

    await expect(
      service.activateVersion(identity, PROJECT_ID, ACTIVE_ENVIRONMENT_ID, "stale-rollback", {
        expectedActiveEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const rolledBack = await service.activateVersion(
      identity,
      PROJECT_ID,
      ACTIVE_ENVIRONMENT_ID,
      "rollback-candidate",
      { expectedActiveEnvironmentVersionId: CANDIDATE_ENVIRONMENT_ID },
    );
    expect(rolledBack.activeEnvironmentVersionId).toBe(ACTIVE_ENVIRONMENT_ID);
    expect(rolledBack.operations[0]).toMatchObject({
      kind: "rollback",
      fromEnvironmentVersionId: CANDIDATE_ENVIRONMENT_ID,
      toEnvironmentVersionId: ACTIVE_ENVIRONMENT_ID,
    });
  });

  it("does not expose a project across tenant identity boundaries", async () => {
    const foreignIdentity = {
      ...identity,
      tenantId: "f0000000-0000-4000-8000-000000000001",
    };
    await expect(service.history(foreignIdentity, PROJECT_ID)).rejects.toBeInstanceOf(
      ControlPlaneStoreError,
    );
    await expect(service.history(foreignIdentity, PROJECT_ID)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
