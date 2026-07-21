import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HttpSandboxAssignmentInventory,
  HttpSupervisorManagementClient,
  HttpSupervisorOwnerBoundary,
} from "@agent-dock/control-plane";
import {
  SupervisorBootLedger,
  SupervisorManagementServer,
  type SupervisorHostBootIdentity,
} from "../src/index.ts";

const TOKEN = `owner-${"m".repeat(48)}`;
const IDENTITY: SupervisorHostBootIdentity = {
  supervisorId: "supervisor-management-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
};
const RUNTIME_ID = "66666666-6666-4666-8666-666666666666";
const ASSIGNMENT = {
  runtimeId: RUNTIME_ID,
  runtimeName: "agent-dock-runtime-1",
  ...IDENTITY,
  commandId: "10000000-0000-4000-8000-000000000003",
  sessionId: "10000000-0000-4000-8000-000000000004",
  turnId: "10000000-0000-4000-8000-000000000005",
  leaseId: "10000000-0000-4000-8000-000000000006",
  fencingToken: 3,
};
const PROTOCOL_ASSIGNMENT = {
  containerId: ASSIGNMENT.runtimeId,
  containerName: ASSIGNMENT.runtimeName,
  supervisorId: ASSIGNMENT.supervisorId,
  bootId: ASSIGNMENT.bootId,
  sandboxId: ASSIGNMENT.sandboxId,
  commandId: ASSIGNMENT.commandId,
  sessionId: ASSIGNMENT.sessionId,
  turnId: ASSIGNMENT.turnId,
  leaseId: ASSIGNMENT.leaseId,
  fencingToken: ASSIGNMENT.fencingToken,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-management-"));
  roots.push(directory);
  const ledger = new SupervisorBootLedger({
    rootDirectory: directory,
    supervisorId: IDENTITY.supervisorId,
  });
  await ledger.beginBoot(IDENTITY);
  let ready = false;
  let stopCalls = 0;
  let assignments = [PROTOCOL_ASSIGNMENT];
  let terminationCalls = 0;
  const server = new SupervisorManagementServer({
    host: "127.0.0.1",
    port: 0,
    managementToken: TOKEN,
    identity: IDENTITY,
    bootLedger: ledger,
    readiness: () => ready,
    stopCurrentBoot: async () => {
      stopCalls += 1;
    },
    assignmentInventory: {
      async listAssignments(sandboxId) {
        return assignments.filter((assignment) => assignment.sandboxId === sandboxId);
      },
      async terminateAndConfirmAbsent(assignment) {
        terminationCalls += 1;
        assignments = assignments.filter(
          (candidate) => candidate.containerId !== assignment.containerId,
        );
      },
      async confirmAbsent(assignment) {
        if (assignments.some((candidate) => candidate.containerId === assignment.containerId)) {
          throw Object.assign(new Error("still alive"), {
            code: "tool_sandbox_still_alive",
            retryable: false,
          });
        }
      },
    },
    artifactStore: {
      async get(objectKey) {
        if (objectKey !== "checkpoints/tenant/session/workspace.json") throw new Error("missing");
        return Buffer.from("trusted-artifact");
      },
    },
  });
  const address = await server.listen();
  const client = new HttpSupervisorManagementClient({
    baseUrl: address,
    managementToken: TOKEN,
    allowInsecureHttp: true,
  });
  return {
    ledger,
    server,
    address,
    client,
    setReady(value: boolean) {
      ready = value;
    },
    stopCalls() {
      return stopCalls;
    },
    terminationCalls() {
      return terminationCalls;
    },
  };
}

describe("trusted Supervisor management boundary", () => {
  it("exposes safe health and exact idempotent owner-stop proof", async () => {
    const value = await harness();
    try {
      const live = await fetch(`${value.address}/health/live`);
      expect(await live.json()).toEqual({ status: "ok" });
      const notReady = await fetch(`${value.address}/health/ready`);
      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toEqual({ status: "not_ready" });
      value.setReady(true);
      expect((await fetch(`${value.address}/health/ready`)).status).toBe(200);

      const unauthorized = await fetch(`${value.address}/internal/v1/supervisor/manage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "owner.stop_and_confirm",
          requestId: globalThis.crypto.randomUUID(),
          identity: IDENTITY,
        }),
      });
      expect(unauthorized.status).toBe(401);

      const owner = new HttpSupervisorOwnerBoundary(value.client);
      await owner.stopAndConfirm(IDENTITY);
      await owner.stopAndConfirm(IDENTITY);
      expect(value.stopCalls()).toBe(1);
      await expect(value.ledger.current()).resolves.toMatchObject({ status: "stopped" });
      await expect(
        owner.stopAndConfirm({ ...IDENTITY, bootId: globalThis.crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: "boot_generation_unknown", retryable: false });
    } finally {
      await value.server.close();
    }
  });

  it("round-trips exact Tool Sandbox inventory and absence proof through the manager boundary", async () => {
    const value = await harness();
    try {
      const inventory = new HttpSandboxAssignmentInventory(value.client, IDENTITY.sandboxId);
      await expect(inventory.listAssignments()).resolves.toEqual([ASSIGNMENT]);

      await expect(inventory.terminateAndConfirmAbsent(ASSIGNMENT)).resolves.toBeUndefined();
      expect(value.terminationCalls()).toBe(1);

      const unknownInventory = new HttpSandboxAssignmentInventory(
        value.client,
        globalThis.crypto.randomUUID(),
      );
      await expect(unknownInventory.listAssignments()).rejects.toMatchObject({
        code: "boot_generation_unknown",
        retryable: false,
      });
      await expect(
        inventory.terminateAndConfirmAbsent({
          ...ASSIGNMENT,
          bootId: globalThis.crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "assignment_scope_mismatch", retryable: false });
      expect(value.terminationCalls()).toBe(1);
    } finally {
      await value.server.close();
    }
  });

  it("requires explicit opt-in for a plaintext management network", () => {
    expect(
      () =>
        new HttpSupervisorManagementClient({
          baseUrl: "http://supervisor-host:4100",
          managementToken: TOKEN,
        }),
    ).toThrow("Plain HTTP Supervisor management requires explicit opt-in");
  });

  it("transports bounded artifacts only over the authenticated management boundary", async () => {
    const value = await harness();
    try {
      const bytes = await value.client.readArtifact("checkpoints/tenant/session/workspace.json");
      expect(Buffer.from(bytes)).toEqual(Buffer.from("trusted-artifact"));
      const unauthorized = await fetch(`${value.address}/internal/v1/artifacts/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objectKey: "checkpoints/tenant/session/workspace.json" }),
      });
      expect(unauthorized.status).toBe(401);
      await expect(value.client.readArtifact("../../etc/passwd")).rejects.toMatchObject({
        code: "checkpoint_object_key_invalid",
      });
    } finally {
      await value.server.close();
    }
  });
});
