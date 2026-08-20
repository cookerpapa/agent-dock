import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  type EnvironmentValidationReport,
} from "@pi-cloud/protocol";
import {
  PostgresSandboxActivationStateRepository,
  ToolBroker,
  ToolBrokerServer,
  type SandboxHandle,
  type SandboxProvider,
} from "@pi-cloud/tool-broker";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { DevelopmentEnvironmentService } from "../src/development-environment-service.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import type { TenantRequestIdentity } from "../src/tenant-identity.ts";

const DOMAIN_ID = "sandbox-domain-development";
const TOKEN = `development-environment-${"t".repeat(48)}`;
const IMAGE_REVISION = "development-environment-test";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let server: ToolBrokerServer;
let service: DevelopmentEnvironmentService;
let stateRepository: PostgresSandboxActivationStateRepository;
let identity: TenantRequestIdentity;
let otherIdentity: TenantRequestIdentity;
let workspaceId: string;
const pauses = vi.fn(async () => undefined);
const resumes = vi.fn(async (handle: SandboxHandle) => handle);
const destroys = vi.fn(async (_handle: SandboxHandle) => undefined);

function provider(): SandboxProvider {
  const validation: EnvironmentValidationReport = {
    profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
    profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
    imageRevision: IMAGE_REVISION,
    specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
    recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    isolationBoundary: "microvm",
    runtime: "cubesandbox-kvm",
    networkMode: "public_web_proxy_private_denied",
    runAsUser: "1000:1000",
    readOnlyRootFilesystem: false,
    tools: [
      { name: "git", version: "2" },
      { name: "node", version: "24" },
      { name: "java", version: "17" },
      { name: "python", version: "3.11" },
    ],
    recipeCommands: [],
  };
  return {
    providerId: "cubesandbox",
    async checkHealth() {},
    async create(spec) {
      return {
        providerApiVersion: 1,
        providerId: "cubesandbox",
        activationId: spec.activationId,
        runtimeId: spec.activationId,
        runtimeName: `development-${spec.activationId}`,
        workspaceRoot: "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation: validation,
      };
    },
    async rebind(handle, assignment) {
      return { ...handle, assignment };
    },
    async exec() {
      throw new Error("not used");
    },
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
    async openTerminal() {
      return {
        pid: 1,
        output: { async *[Symbol.asyncIterator]() {} },
        async sendInput() {},
        async resize() {},
        async kill() {},
        disconnect() {},
      };
    },
    pause: pauses,
    resume: resumes,
    async snapshot() {
      throw new Error("not used");
    },
    async stop(handle) {
      await destroys(handle);
    },
    destroy: destroys,
    async inspect(handle) {
      return { providerApiVersion: 1, providerId: "cubesandbox", state: "absent", handle };
    },
    async destroyActivation() {},
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {},
    async confirmAbsent() {},
    async close() {},
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: "development-environment",
    ownerDisplayName: "Environment Owner",
    quotas: {
      maximumProjects: 4,
      maximumSessions: 16,
      maximumUnsettledTurns: 16,
      maximumConcurrentTurns: 4,
      maximumActiveSandboxes: 4,
    },
  });
  const otherUserId = "88888888-8888-4888-8888-888888888888";
  await database
    .insertInto("users")
    .values({ id: otherUserId, tenant_id: tenant.tenantId, display_name: "Other User" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sandbox_domains")
    .values({
      id: DOMAIN_ID,
      display_name: "Development",
      state: "active",
      tool_broker_base_url: "http://127.0.0.1:1",
      workspace_storage_key: "development-volume",
      maximum_active_sandboxes: 8,
    })
    .executeTakeFirstOrThrow();
  await database
    .updateTable("sandbox_domains")
    .set({ state: "disabled" })
    .where("id", "=", "sandbox-domain-0001")
    .execute();
  const store = new ControlPlaneStore({
    database,
    tenantId: tenant.tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
    environmentImageRevision: IMAGE_REVISION,
  });
  const project = await store.createProject({
    name: "exclusive-workspace",
    source: { kind: "empty" },
  });
  workspaceId = project.workspaceId;
  identity = {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: "Environment Owner",
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
  otherIdentity = { ...identity, userId: otherUserId, displayName: "Other User", role: "member" };
  const ownerBaseUrl = "http://127.0.0.1:4300";
  stateRepository = new PostgresSandboxActivationStateRepository({
    database,
    sandboxDomainId: DOMAIN_ID,
    instanceId: "99999999-9999-4999-8999-999999999999",
    ownerBaseUrl,
  });
  await stateRepository.start();
  server = new ToolBrokerServer({
    host: "127.0.0.1",
    port: 0,
    serviceToken: `service-${"s".repeat(48)}`,
    terminalToken: TOKEN,
    broker: new ToolBroker({
      provider: provider(),
      stateRepository,
      ownerBaseUrl,
      maximumActiveSandboxes: 4,
      imageRevision: IMAGE_REVISION,
    }),
  });
  const address = await server.listen();
  await database
    .updateTable("sandbox_domains")
    .set({ tool_broker_base_url: address })
    .where("id", "=", DOMAIN_ID)
    .executeTakeFirstOrThrow();
  service = new DevelopmentEnvironmentService({
    database,
    terminalToken: TOKEN,
    allowInsecureInternalHttp: true,
  });
}, 30_000);

afterAll(async () => {
  await server?.close();
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe("user-owned development environments", () => {
  it("provisions, isolates visibility, pauses, resumes and releases one Workspace KVM", async () => {
    const created = await service.create(identity, "create-exclusive", { workspaceId });
    expect(created).toMatchObject({ workspaceId, state: "running", generation: 1 });
    await expect(
      stateRepository.reserve({
        activationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        assignment: {
          tenantId: identity.tenantId,
          projectId: created.projectId,
          workspaceId,
          supervisorId: "worker",
          bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          sandboxId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          commandId: "command",
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          turnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          attemptId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          leaseId: "11111111-1111-4111-8111-111111111111",
          fencingToken: 1,
        },
        capabilitySha256: "a".repeat(64),
        turnContextSha256: "b".repeat(64),
        attemptContextSha256: "c".repeat(64),
        environmentSha256: "d".repeat(64),
      }),
    ).resolves.toEqual({ status: "busy" });
    await expect(service.list(otherIdentity)).resolves.toEqual({
      environments: [],
      truncated: false,
    });
    await expect(service.get(otherIdentity, created.environmentId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.create(identity, "create-exclusive-replay", { workspaceId }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      service.action(identity, created.environmentId, "pause-exclusive", { action: "pause" }),
    ).resolves.toMatchObject({ state: "paused" });
    expect(pauses).toHaveBeenCalledOnce();
    await expect(
      service.action(identity, created.environmentId, "resume-exclusive", { action: "resume" }),
    ).resolves.toMatchObject({ state: "running" });
    expect(resumes).toHaveBeenCalledOnce();
    await expect(
      service.action(identity, created.environmentId, "release-exclusive", { action: "release" }),
    ).resolves.toMatchObject({ state: "released", releasedAt: expect.any(String) });
    expect(destroys).toHaveBeenCalledOnce();
  });
});
