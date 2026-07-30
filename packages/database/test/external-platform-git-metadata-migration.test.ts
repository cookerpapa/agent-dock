import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  downExternalPlatformGitMetadata,
  runMigrations,
  upExternalPlatformGitMetadata,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: ReturnType<typeof createDatabase>;

const tenantId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const environmentId = "30000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe("external platform Git metadata migration", () => {
  it("replaces the root-repository recipe and its database defaults without a compatibility branch", async () => {
    await applyCompiledQueries(pglite, await compileMigration(downExternalPlatformGitMetadata));
    await database
      .insertInto("tenants")
      .values({ id: tenantId, slug: "external-platform-git" })
      .execute();
    await database
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "External platform Git" })
      .execute();
    await database
      .insertInto("environment_versions")
      .values({
        id: environmentId,
        tenant_id: tenantId,
        project_id: projectId,
        version_number: 1,
        profile_key: "agent-dock-fullstack",
        profile_version: "1",
        image_revision: "development",
        spec_sha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        state: "pending",
        active: true,
        validated_at: null,
      })
      .execute();

    await applyCompiledQueries(pglite, await compileMigration(upExternalPlatformGitMetadata));
    const migrated = await database
      .selectFrom("environment_versions")
      .select(["recipe", "recipe_sha256", "state", "validated_at"])
      .where("id", "=", environmentId)
      .executeTakeFirstOrThrow();
    expect(migrated).toMatchObject({
      recipe: {
        schemaVersion: 1,
        setupCommands: [],
        verificationCommands: [
          {
            id: "workspace-root",
            command: 'test "$PWD" = /workspace && test -w .',
          },
        ],
      },
      recipe_sha256: "2d6c5260fe7bc3901e454ff93106dc5ed263d6edbbabf7bafdf852021289e5ba",
      state: "pending",
      validated_at: null,
    });

    const secondEnvironmentId = "30000000-0000-4000-8000-000000000002";
    await database
      .insertInto("environment_versions")
      .values({
        id: secondEnvironmentId,
        tenant_id: tenantId,
        project_id: projectId,
        version_number: 2,
        profile_key: "agent-dock-fullstack",
        profile_version: "1",
        image_revision: "development",
        spec_sha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        state: "pending",
        active: false,
        validated_at: null,
      })
      .execute();
    await expect(
      database
        .selectFrom("environment_versions")
        .select(["recipe_sha256"])
        .where("id", "=", secondEnvironmentId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      recipe_sha256: "2d6c5260fe7bc3901e454ff93106dc5ed263d6edbbabf7bafdf852021289e5ba",
    });
  });
});
