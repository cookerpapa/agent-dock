import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresSupervisorCredentialAuthorizer,
  SUPERVISOR_BOOT_PROVISION_PATH,
  SupervisorBootProvisionError,
  SupervisorBootProvisioner,
  SupervisorProvisioningGateway,
  SupervisorUpgradeAuthorizationError,
} from "../src/index.ts";

const ENROLLMENT_TOKEN = `enroll-${"e".repeat(48)}`;
const SUPERVISOR_ID = "production-supervisor-test";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

function credential() {
  const secret = randomBytes(32).toString("base64url");
  return {
    id: uuid(),
    secret,
    sha256: createHash("sha256").update(secret).digest("hex"),
  };
}

function request(
  options: { capacity?: number; supervisorId?: string; managementBaseUrl?: string } = {},
) {
  const connectionCredential = credential();
  const supervisorId = options.supervisorId ?? SUPERVISOR_ID;
  return {
    connectionCredential,
    body: {
      protocolVersion: 1 as const,
      type: "supervisor.boot.provision" as const,
      requestId: uuid(),
      supervisorId,
      bootId: uuid(),
      sandboxId: uuid(),
      credentialId: connectionCredential.id,
      credentialSha256: connectionCredential.sha256,
      maxConcurrentSessions: options.capacity ?? 2,
      managementBaseUrl: options.managementBaseUrl ?? `http://${supervisorId}:4100`,
    },
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("production Supervisor boot provisioning", () => {
  it("authenticates enrollment and provisions an idempotent short-lived boot credential", async () => {
    const now = new Date("2026-07-19T10:00:00.000Z");
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: "production-supervisor-",
      managementBaseUrlTemplate: "http://{supervisorId}:4100",
      maximumCapacity: 4,
      enrollmentToken: ENROLLMENT_TOKEN,
      credentialTtlMs: 60_000,
      clock: () => now,
    });
    expect(() =>
      provisioner.authorize("Bearer wrong-credential-that-is-long-enough-123456"),
    ).toThrow(SupervisorBootProvisionError);
    provisioner.authorize(`Bearer ${ENROLLMENT_TOKEN}`);

    const value = request();
    await expect(provisioner.provision(value.body)).resolves.toMatchObject({
      requestId: value.body.requestId,
      bootId: value.body.bootId,
      idempotent: false,
      expiresAt: "2026-07-19T10:01:00.000Z",
    });
    await expect(provisioner.provision(value.body)).resolves.toMatchObject({
      idempotent: true,
    });

    const authorizer = new PostgresSupervisorCredentialAuthorizer({
      database,
      clock: () => now,
    });
    await expect(
      authorizer.authorize({
        authorization: `Bearer ${value.connectionCredential.id}.${value.connectionCredential.secret}`,
        remoteAddress: "127.0.0.1",
        tlsAuthorized: false,
        peerCertificateFingerprint256: undefined,
      }),
    ).resolves.toEqual({
      supervisorId: SUPERVISOR_ID,
      bootId: value.body.bootId,
      sandboxId: value.body.sandboxId,
    });
    await expect(
      authorizer.authorize({
        authorization: `Bearer ${value.connectionCredential.id}.${"x".repeat(43)}`,
        remoteAddress: "127.0.0.1",
        tlsAuthorized: false,
        peerCertificateFingerprint256: undefined,
      }),
    ).rejects.toBeInstanceOf(SupervisorUpgradeAuthorizationError);
  });

  it("revokes the prior boot credential and rejects changed identity reuse", async () => {
    const now = new Date("2026-07-19T11:00:00.000Z");
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: "production-supervisor-",
      managementBaseUrlTemplate: "http://{supervisorId}:4100",
      maximumCapacity: 4,
      enrollmentToken: ENROLLMENT_TOKEN,
      clock: () => now,
    });
    const first = request();
    const second = request();
    await provisioner.provision(first.body);
    await provisioner.provision(second.body);
    const firstRow = await database
      .selectFrom("supervisor_boot_credentials")
      .select("revoked_at")
      .where("credential_id", "=", first.connectionCredential.id)
      .executeTakeFirstOrThrow();
    expect(firstRow.revoked_at).toEqual(now);

    const changed = { ...second.body, credentialSha256: "f".repeat(64) };
    await expect(provisioner.provision(changed)).rejects.toMatchObject({
      code: "provision_identity_conflict",
      statusCode: 409,
    });
    await expect(provisioner.provision(request({ capacity: 5 }).body)).rejects.toMatchObject({
      code: "provision_policy_rejected",
      statusCode: 403,
    });

    const concurrentA = request();
    const concurrentB = request();
    await Promise.all([
      provisioner.provision(concurrentA.body),
      provisioner.provision(concurrentB.body),
    ]);
    const activeCredentials = await database
      .selectFrom("supervisor_boot_credentials")
      .select("credential_id")
      .where("supervisor_id", "=", SUPERVISOR_ID)
      .where("revoked_at", "is", null)
      .execute();
    expect(activeCredentials).toHaveLength(1);
  });

  it("enrolls independent worker identities and rejects management endpoint spoofing", async () => {
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: "production-supervisor-",
      managementBaseUrlTemplate: "http://{supervisorId}:4100",
      maximumCapacity: 4,
      enrollmentToken: ENROLLMENT_TOKEN,
    });
    const workerA = request({ supervisorId: "production-supervisor-a" });
    const workerB = request({ supervisorId: "production-supervisor-b" });
    await expect(
      Promise.all([provisioner.provision(workerA.body), provisioner.provision(workerB.body)]),
    ).resolves.toHaveLength(2);
    await expect(
      provisioner.provision(
        request({
          supervisorId: "production-supervisor-c",
          managementBaseUrl: "http://metadata.internal:4100",
        }).body,
      ),
    ).rejects.toMatchObject({ code: "provision_policy_rejected", statusCode: 403 });
    await expect(
      provisioner.provision(request({ supervisorId: "unexpected-worker" }).body),
    ).rejects.toMatchObject({ code: "provision_policy_rejected", statusCode: 403 });
  });

  it("serves the bounded internal endpoint without exposing raw errors", async () => {
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: "production-supervisor-",
      managementBaseUrlTemplate: "http://{supervisorId}:4100",
      maximumCapacity: 4,
      enrollmentToken: ENROLLMENT_TOKEN,
      clock: () => new Date("2026-07-19T12:00:00.000Z"),
    });
    const gateway = new SupervisorProvisioningGateway({ provisioner });
    const server = Fastify({ logger: false });
    gateway.install(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      const value = request();
      const unauthorized = await fetch(`${address}${SUPERVISOR_BOOT_PROVISION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value.body),
      });
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toMatchObject({
        error: { code: "invalid_enrollment_credential", retryable: false },
      });

      const accepted = await fetch(`${address}${SUPERVISOR_BOOT_PROVISION_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ENROLLMENT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(value.body),
      });
      const acceptedBody = await accepted.json();
      expect({ status: accepted.status, body: acceptedBody }).toMatchObject({
        status: 201,
        body: {
          requestId: value.body.requestId,
          credentialId: value.connectionCredential.id,
        },
      });
    } finally {
      await server.close();
    }
  });
});
