import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: execFileMock };
});

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
const RUNTIME_ID = "a".repeat(64);
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

const roots: string[] = [];
const dockerResults: Array<{ code: number; stdout?: string; stderr?: string }> = [];

function inspection(): string {
  return JSON.stringify([
    {
      Id: RUNTIME_ID,
      Name: `/${ASSIGNMENT.runtimeName}`,
      Config: {
        Labels: {
          "agent-dock.managed": "true",
          "agent-dock.supervisor-id": IDENTITY.supervisorId,
          "agent-dock.boot-id": IDENTITY.bootId,
          "agent-dock.sandbox-id": IDENTITY.sandboxId,
          "agent-dock.command-id": ASSIGNMENT.commandId,
          "agent-dock.session-id": ASSIGNMENT.sessionId,
          "agent-dock.turn-id": ASSIGNMENT.turnId,
          "agent-dock.lease-id": ASSIGNMENT.leaseId,
          "agent-dock.fencing-token": String(ASSIGNMENT.fencingToken),
        },
      },
    },
  ]);
}

beforeEach(() => {
  dockerResults.length = 0;
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: (Error & { code?: number }) | null,
      stdout: string,
      stderr: string,
    ) => void;
    const result = dockerResults.shift();
    if (result === undefined) throw new Error("Unexpected fake Docker command");
    queueMicrotask(() => {
      callback(
        result.code === 0
          ? null
          : Object.assign(new Error("fake Docker command failed"), { code: result.code }),
        result.stdout ?? "",
        result.stderr ?? "",
      );
    });
    return {};
  });
});

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
    dockerCommand: "fake-docker",
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

  it("round-trips exact Docker assignment inventory and absence proof", async () => {
    const value = await harness();
    try {
      const inventory = new HttpSandboxAssignmentInventory(value.client, IDENTITY.sandboxId);
      dockerResults.push({ code: 0, stdout: `${RUNTIME_ID}\n` }, { code: 0, stdout: inspection() });
      await expect(inventory.listAssignments()).resolves.toEqual([ASSIGNMENT]);

      dockerResults.push(
        { code: 0, stdout: inspection() },
        { code: 0, stdout: RUNTIME_ID },
        { code: 1, stderr: `No such container: ${RUNTIME_ID}` },
      );
      await expect(inventory.terminateAndConfirmAbsent(ASSIGNMENT)).resolves.toBeUndefined();
      expect(execFileMock).toHaveBeenCalledTimes(5);
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
});
