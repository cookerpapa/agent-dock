import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  SandboxCheckpointStoreError,
  type CheckpointObjectStore,
} from "@agent-dock/runtime-core/checkpoint-runtime";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type ExecuteTurnCommandMessage,
  type GitHubRepositorySource,
} from "@agent-dock/protocol";
import { createWorkspaceSnapshot, parseWorkspaceSnapshot } from "@agent-dock/workspace-runtime";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceSeedResolver, WorkspaceSeedError } from "../src/index.ts";

// Each case starts and migrates a real PGlite socket. Under the full workspace
// CI load this can legitimately cross Vitest's 5-second unit-test default.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  foreignTenant: "10000000-0000-4000-8000-000000000002",
  project: "20000000-0000-4000-8000-000000000001",
  workspace: "30000000-0000-4000-8000-000000000001",
  message: "40000000-0000-4000-8000-000000000001",
  command: "50000000-0000-4000-8000-000000000001",
  session: "60000000-0000-4000-8000-000000000001",
  turn: "70000000-0000-4000-8000-000000000001",
  lease: "80000000-0000-4000-8000-000000000001",
  profile: "90000000-0000-4000-8000-000000000001",
  credential: "a0000000-0000-4000-8000-000000000001",
  environment: "b0000000-0000-4000-8000-000000000001",
  run: "60000000-0000-4000-8000-000000000001",
} as const;
const SOURCE: GitHubRepositorySource = {
  kind: "github_public",
  repository: "octocat/hello-world",
  commitSha: "b".repeat(40),
};
const SNAPSHOT = Buffer.from(
  `${JSON.stringify({ format: "agent-dock.workspace-manifest.v1", files: [] })}\n`,
);

class MemoryObjectStore implements CheckpointObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    if (this.objects.has(objectKey)) {
      throw new SandboxCheckpointStoreError(
        "checkpoint_object_exists",
        "Checkpoint object already exists",
        false,
      );
    }
    this.objects.set(objectKey, Uint8Array.from(bytes));
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const bytes = this.objects.get(objectKey);
    if (bytes === undefined) throw new Error("missing test object");
    return Uint8Array.from(bytes);
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}

type Fixture = {
  database: Kysely<Database>;
  objectStore: MemoryObjectStore;
  close(): Promise<void>;
};

const fixtures: Fixture[] = [];

function command(tenantId: string = IDS.tenant): ExecuteTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: IDS.message,
    sentAt: "2026-07-19T00:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      commandId: IDS.command,
      idempotencyKey: "workspace-seed-1",
      tenantId,
      projectId: IDS.project,
      workspaceId: IDS.workspace,
      sessionId: IDS.session,
      runId: IDS.run,
      turnId: IDS.turn,
      attemptId: "70000000-0000-4000-8000-000000000001",
      agentId: "root",
      leaseId: IDS.lease,
      fencingToken: 1,
      nextEventSeq: 1,
      input: { kind: "prompt", text: "Inspect the imported repository" },
      sandboxRetention: "ephemeral",
      model: {
        profileId: IDS.profile,
        provider: "agent-dock-fake",
        modelId: "agent-dock-fake",
        thinkingLevel: "off",
        credentialBindingId: IDS.credential,
        credentialBindingVersion: 1,
      },
      environment: {
        environmentVersionId: IDS.environment,
        versionNumber: 1,
        profileKey: "agent-dock-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
    },
  };
}

async function fixture(): Promise<Fixture> {
  const pglite = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  const database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    // PGlite's socket shim multiplexes one embedded PostgreSQL engine. A single
    // client still exercises the committed lease race without nested PGlite
    // transaction artifacts that real PostgreSQL does not have.
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await database
    .insertInto("tenants")
    .values([
      { id: IDS.tenant, slug: "workspace-owner" },
      { id: IDS.foreignTenant, slug: "workspace-foreign" },
    ])
    .execute();
  await database
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "Imported source" })
    .execute();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      sandbox_domain_id: "sandbox-domain-0001",
      object_snapshot_key: null,
    })
    .execute();
  await database
    .insertInto("workspace_sources")
    .values({
      tenant_id: IDS.tenant,
      workspace_id: IDS.workspace,
      kind: SOURCE.kind,
      repository: SOURCE.repository,
      commit_sha: SOURCE.commitSha,
      status: "pending",
      object_key: null,
      sha256: null,
      size_bytes: null,
      import_lease_id: null,
      lease_expires_at: null,
      failure_code: null,
    })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "agent-dock-fake",
      kind: "brokered",
      secret_ref: "fixture",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "default",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
    })
    .execute();
  await database
    .insertInto("environment_versions")
    .values({
      id: IDS.environment,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
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
  await database
    .insertInto("sessions")
    .values({
      id: IDS.session,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: IDS.profile,
      state: "running",
    })
    .execute();
  await database
    .insertInto("turns")
    .values({
      id: IDS.turn,
      tenant_id: IDS.tenant,
      session_id: IDS.session,
      state: "running",
      input_kind: "prompt",
      input_text: "Inspect the imported repository",
      model_profile_id: IDS.profile,
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      thinking_level: "off",
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      started_at: new Date(),
    })
    .execute();
  await database
    .insertInto("commands")
    .values({
      id: IDS.command,
      tenant_id: IDS.tenant,
      session_id: IDS.session,
      turn_id: IDS.turn,
      idempotency_key: "workspace-seed-1",
      kind: "turn.execute",
      state: "acknowledged",
      mailbox_position: 1,
      payload: {},
      dispatched_at: new Date(),
      acknowledged_at: new Date(),
    })
    .execute();
  await database
    .insertInto("runs")
    .values({
      id: IDS.run,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      session_id: IDS.session,
      turn_id: IDS.turn,
      command_id: IDS.command,
      environment_version_id: IDS.environment,
      source_set_snapshot: {
        schemaVersion: 1,
        entries: [{ root: ".", ...SOURCE }],
      },
      idempotency_key: "workspace-seed-1",
      state: "queued",
      current_attempt_id: null,
      attempt_count: 0,
    })
    .execute();
  const value: Fixture = {
    database,
    objectStore: new MemoryObjectStore(),
    async close() {
      await database.destroy();
      await socket.stop();
      await pglite.close();
    },
  };
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});

describe("PostgreSQL workspace seed provisioning", () => {
  it("imports once, publishes immutable metadata, and reuses the ready seed", async () => {
    const test = await fixture();
    const importer = { import: vi.fn(async () => Uint8Array.from(SNAPSHOT)) };
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer,
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    const signal = new AbortController().signal;

    await expect(resolver.resolve(command(), signal)).resolves.toEqual(Uint8Array.from(SNAPSHOT));
    await expect(resolver.resolve(command(), signal)).resolves.toEqual(Uint8Array.from(SNAPSHOT));
    expect(importer.import).toHaveBeenCalledTimes(1);
    const source = await test.database
      .selectFrom("workspace_sources as source")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "source.tenant_id")
          .onRef("workspace.id", "=", "source.workspace_id"),
      )
      .select([
        "source.status",
        "source.object_key as sourceObjectKey",
        "source.sha256",
        "source.size_bytes as sizeBytes",
        "workspace.object_snapshot_key as workspaceObjectKey",
      ])
      .where("source.tenant_id", "=", IDS.tenant)
      .where("source.workspace_id", "=", IDS.workspace)
      .executeTakeFirstOrThrow();
    expect(source).toMatchObject({
      status: "ready",
      sizeBytes: String(SNAPSHOT.byteLength),
      workspaceObjectKey: source.sourceObjectKey,
    });
    expect(source.sourceObjectKey).toMatch(
      new RegExp(`^workspace-seeds/${IDS.tenant}/${IDS.workspace}/[0-9a-f]{64}\\.json$`),
    );
    expect(test.objectStore.objects.size).toBe(1);
  });

  it("imports an immutable repository set under disjoint Workspace roots", async () => {
    const test = await fixture();
    const webSnapshot = createWorkspaceSnapshot([
      {
        path: "package.json",
        executable: false,
        content: Buffer.from('{"name":"web"}\n'),
      },
    ]);
    const apiSnapshot = createWorkspaceSnapshot([
      {
        path: "src/index.ts",
        executable: false,
        content: Buffer.from('export const service = "api";\n'),
      },
    ]);
    await test.database
      .updateTable("workspace_sources")
      .set({
        kind: "repository_set",
        repository: null,
        commit_sha: null,
        github_installation_id: null,
        github_repository_id: null,
      })
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", IDS.workspace)
      .execute();
    await test.database
      .insertInto("workspace_repository_sources")
      .values([
        {
          tenant_id: IDS.tenant,
          workspace_id: IDS.workspace,
          ordinal: 1,
          root_path: "web",
          kind: "github_public",
          repository: "octocat/frontend",
          commit_sha: "c".repeat(40),
          github_installation_id: null,
          github_repository_id: null,
        },
        {
          tenant_id: IDS.tenant,
          workspace_id: IDS.workspace,
          ordinal: 2,
          root_path: "api",
          kind: "github_public",
          repository: "octocat/backend",
          commit_sha: "d".repeat(40),
          github_installation_id: null,
          github_repository_id: null,
        },
      ])
      .execute();
    await test.database
      .updateTable("runs")
      .set({
        source_set_snapshot: {
          schemaVersion: 1,
          entries: [
            {
              root: "web",
              kind: "github_public",
              repository: "octocat/frontend",
              commitSha: "c".repeat(40),
            },
            {
              root: "api",
              kind: "github_public",
              repository: "octocat/backend",
              commitSha: "d".repeat(40),
            },
          ],
        },
      })
      .where("id", "=", IDS.run)
      .execute();
    let importsStarted = 0;
    let markBothStarted!: () => void;
    let releaseImports!: () => void;
    const bothStarted = new Promise<void>((resolvePromise) => {
      markBothStarted = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseImports = resolvePromise;
    });
    const importer = {
      import: vi.fn(async (source: GitHubRepositorySource) => {
        importsStarted += 1;
        if (importsStarted === 2) markBothStarted();
        await release;
        return source.repository === "octocat/frontend" ? webSnapshot : apiSnapshot;
      }),
    };
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer,
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });

    const resolving = resolver.resolve(command(), new AbortController().signal);
    await bothStarted;
    releaseImports();
    const resolved = await resolving;
    expect(resolved).toBeDefined();
    expect(
      parseWorkspaceSnapshot(resolved!).map((file) => ({
        path: file.path,
        content: file.content.toString("utf8"),
      })),
    ).toEqual([
      { path: "api/src/index.ts", content: 'export const service = "api";\n' },
      { path: "web/package.json", content: '{"name":"web"}\n' },
    ]);
    expect(importer.import).toHaveBeenCalledTimes(2);
    expect(importer.import).toHaveBeenNthCalledWith(
      1,
      {
        kind: "github_public",
        repository: "octocat/backend",
        commitSha: "d".repeat(40),
      },
      expect.any(AbortSignal),
    );
    const reused = await resolver.resolve(command(), new AbortController().signal);
    expect(Buffer.from(reused!)).toEqual(Buffer.from(resolved!));
    expect(importer.import).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent first activations behind one import lease", async () => {
    const test = await fixture();
    let release!: () => void;
    let markImporterStarted!: () => void;
    const importerStarted = new Promise<void>((resolvePromise) => {
      markImporterStarted = resolvePromise;
    });
    const importer = {
      import: vi.fn(async () => {
        markImporterStarted();
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        return Uint8Array.from(SNAPSHOT);
      }),
    };
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer,
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    const signal = new AbortController().signal;
    const first = resolver.resolve(command(), signal);
    await importerStarted;
    const second = resolver.resolve(command(), signal);
    release();
    const [firstBytes, secondBytes] = await Promise.all([first, second]);
    expect(firstBytes).toEqual(Uint8Array.from(SNAPSHOT));
    expect(secondBytes).toEqual(Uint8Array.from(SNAPSHOT));
    expect(importer.import).toHaveBeenCalledTimes(1);
  });

  it("routes an allowlisted private source through the trusted GitHub Gateway importer", async () => {
    const test = await fixture();
    await test.database
      .insertInto("github_app_installations")
      .values({
        tenant_id: IDS.tenant,
        installation_id: 7,
        account_id: 9,
        account_login: "acme",
        target_type: "Organization",
        repository_selection: "selected",
        status: "active",
        permissions: { contents: "read" },
      })
      .execute();
    await test.database
      .insertInto("github_repositories")
      .values({
        tenant_id: IDS.tenant,
        repository_id: 42,
        installation_id: 7,
        full_name: "acme/private-repo",
        owner_login: "acme",
        name: "private-repo",
        private: true,
        default_branch: "main",
        enabled: true,
      })
      .execute();
    await test.database
      .updateTable("workspace_sources")
      .set({
        kind: "github_app",
        repository: "acme/private-repo",
        commit_sha: "c".repeat(40),
        github_installation_id: 7,
        github_repository_id: 42,
      })
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", IDS.workspace)
      .execute();
    await test.database
      .updateTable("runs")
      .set({
        source_set_snapshot: {
          schemaVersion: 1,
          entries: [
            {
              root: ".",
              kind: "github_app",
              installationId: 7,
              repositoryId: 42,
              repository: "acme/private-repo",
              commitSha: "c".repeat(40),
              private: true,
            },
          ],
        },
      })
      .where("id", "=", IDS.run)
      .execute();
    const publicImporter = { import: vi.fn(async () => Uint8Array.from(SNAPSHOT)) };
    const privateImporter = { import: vi.fn(async () => Uint8Array.from(SNAPSHOT)) };
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer: publicImporter,
      privateImporter,
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    await expect(resolver.resolve(command(), new AbortController().signal)).resolves.toEqual(
      Uint8Array.from(SNAPSHOT),
    );
    expect(publicImporter.import).not.toHaveBeenCalled();
    expect(privateImporter.import).toHaveBeenCalledWith(
      { installationId: 7, repositoryId: 42, commitSha: "c".repeat(40) },
      expect.any(AbortSignal),
    );
  });

  it("reclaims an expired import lease", async () => {
    const test = await fixture();
    await test.database
      .updateTable("workspace_sources")
      .set({
        status: "importing",
        import_lease_id: "b0000000-0000-4000-8000-000000000001",
        lease_expires_at: new Date("2026-07-18T00:00:00.000Z"),
      })
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", IDS.workspace)
      .execute();
    const importer = { import: vi.fn(async () => Uint8Array.from(SNAPSHOT)) };
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer,
      clock: () => new Date("2026-07-19T00:00:00.000Z"),
      idGenerator: () => "b0000000-0000-4000-8000-000000000002",
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    await expect(resolver.resolve(command(), new AbortController().signal)).resolves.toEqual(
      Uint8Array.from(SNAPSHOT),
    );
    expect(importer.import).toHaveBeenCalledTimes(1);
    await expect(
      test.database
        .selectFrom("workspace_sources")
        .select(["status", "import_lease_id"])
        .where("tenant_id", "=", IDS.tenant)
        .where("workspace_id", "=", IDS.workspace)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "ready", import_lease_id: null });
  });

  it("prevents a stale importer from publishing after its lease is replaced", async () => {
    const test = await fixture();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      markStarted = resolvePromise;
    });
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer: {
        async import() {
          markStarted();
          await new Promise<void>((resolvePromise) => {
            release = resolvePromise;
          });
          return Uint8Array.from(SNAPSHOT);
        },
      },
      idGenerator: () => "b0000000-0000-4000-8000-000000000003",
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    const resolving = resolver.resolve(command(), new AbortController().signal);
    await started;
    const replacementLease = "b0000000-0000-4000-8000-000000000004";
    await test.database
      .updateTable("workspace_sources")
      .set({
        import_lease_id: replacementLease,
        lease_expires_at: new Date(Date.now() + 60_000),
      })
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", IDS.workspace)
      .where("status", "=", "importing")
      .execute();
    release();
    await expect(resolving).rejects.toMatchObject({
      code: "workspace_import_lease_lost",
      retryable: true,
    });
    const source = await test.database
      .selectFrom("workspace_sources")
      .select(["status", "import_lease_id", "object_key"])
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", IDS.workspace)
      .executeTakeFirstOrThrow();
    expect(source).toEqual({
      status: "importing",
      import_lease_id: replacementLease,
      object_key: null,
    });
  });

  it("fails closed on tenant mismatch and ready-object tampering", async () => {
    const test = await fixture();
    const importer = { import: vi.fn(async () => Uint8Array.from(SNAPSHOT)) };
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer,
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    const signal = new AbortController().signal;
    await expect(resolver.resolve(command(IDS.foreignTenant), signal)).rejects.toMatchObject({
      code: "workspace_source_unavailable",
    });
    await resolver.resolve(command(), signal);
    const [objectKey] = test.objectStore.objects.keys();
    expect(objectKey).toBeDefined();
    test.objectStore.objects.set(objectKey!, Buffer.from("tampered"));
    await expect(resolver.resolve(command(), signal)).rejects.toMatchObject({
      code: "workspace_seed_integrity_failed",
      retryable: false,
    });
  });

  it("rejects a Run whose immutable source snapshot does not match its Workspace source", async () => {
    const test = await fixture();
    await test.database
      .updateTable("runs")
      .set({
        source_set_snapshot: {
          schemaVersion: 1,
          entries: [{ root: ".", ...SOURCE, commitSha: "f".repeat(40) }],
        },
      })
      .where("id", "=", IDS.run)
      .execute();
    const importer = { import: vi.fn(async () => Uint8Array.from(SNAPSHOT)) };
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer,
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    await expect(resolver.resolve(command(), new AbortController().signal)).rejects.toMatchObject({
      code: "workspace_source_snapshot_mismatch",
      retryable: false,
    });
    expect(importer.import).not.toHaveBeenCalled();
  });

  it("records a safe retryable failure without publishing partial metadata", async () => {
    const test = await fixture();
    const resolver = new PostgresWorkspaceSeedResolver({
      database: test.database,
      objectStore: test.objectStore,
      importer: {
        async import() {
          throw new WorkspaceSeedError("UPSTREAM bad-code", "Import unavailable", true);
        },
      },
      pollIntervalMs: 5,
      maximumWaitMs: 2_000,
    });
    await expect(resolver.resolve(command(), new AbortController().signal)).rejects.toMatchObject({
      message: "Import unavailable",
      retryable: true,
    });
    const source = await test.database
      .selectFrom("workspace_sources")
      .select(["status", "failure_code", "object_key", "import_lease_id"])
      .where("tenant_id", "=", IDS.tenant)
      .where("workspace_id", "=", IDS.workspace)
      .executeTakeFirstOrThrow();
    expect(source).toEqual({
      status: "failed",
      failure_code: "upstream_bad_code",
      object_key: null,
      import_lease_id: null,
    });
    expect(test.objectStore.objects.size).toBe(0);
  });
});
