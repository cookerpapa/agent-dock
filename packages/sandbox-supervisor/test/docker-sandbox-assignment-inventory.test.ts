import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: execFileMock };
});

import {
  DockerSandboxAssignmentInventory,
  type SandboxRuntimeAssignment,
} from "../src/docker-sandbox-assignment-inventory.ts";

const RUNTIME_ID = "a".repeat(64);
const SANDBOX_ID = "50000000-0000-4000-8000-000000000001";

type DockerResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

const queuedResults: DockerResult[] = [];

function inspection(overrides: Partial<Record<string, string>> = {}): {
  raw: string;
  assignment: SandboxRuntimeAssignment;
} {
  const labels = {
    "agent-dock.managed": "true",
    "agent-dock.supervisor-id": "supervisor-1",
    "agent-dock.boot-id": "60000000-0000-4000-8000-000000000001",
    "agent-dock.sandbox-id": SANDBOX_ID,
    "agent-dock.command-id": "20000000-0000-4000-8000-000000000001",
    "agent-dock.session-id": "70000000-0000-4000-8000-000000000001",
    "agent-dock.turn-id": "80000000-0000-4000-8000-000000000001",
    "agent-dock.lease-id": "30000000-0000-4000-8000-000000000001",
    "agent-dock.fencing-token": "3",
    ...overrides,
  };
  return {
    raw: JSON.stringify([
      {
        Id: RUNTIME_ID,
        Name: "/agent-dock-runtime-1",
        Config: { Labels: labels },
      },
    ]),
    assignment: {
      runtimeId: RUNTIME_ID,
      runtimeName: "agent-dock-runtime-1",
      supervisorId: labels["agent-dock.supervisor-id"],
      bootId: labels["agent-dock.boot-id"],
      sandboxId: labels["agent-dock.sandbox-id"],
      commandId: labels["agent-dock.command-id"],
      sessionId: labels["agent-dock.session-id"],
      turnId: labels["agent-dock.turn-id"],
      leaseId: labels["agent-dock.lease-id"],
      fencingToken: Number(labels["agent-dock.fencing-token"]),
    },
  };
}

beforeEach(() => {
  queuedResults.length = 0;
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: (Error & { code?: number }) | null,
      stdout: string,
      stderr: string,
    ) => void;
    const result = queuedResults.shift();
    if (result === undefined) throw new Error("Unexpected fake Docker command");
    queueMicrotask(() => {
      const error =
        result.code === 0
          ? null
          : Object.assign(new Error("fake Docker command failed"), { code: result.code });
      callback(error, result.stdout ?? "", result.stderr ?? "");
    });
    return {};
  });
});

describe("DockerSandboxAssignmentInventory", () => {
  it("lists a fully labelled runtime and removes only that exact identity", async () => {
    const observed = inspection();
    queuedResults.push({ code: 0, stdout: `${RUNTIME_ID}\n` }, { code: 0, stdout: observed.raw });
    const inventory = new DockerSandboxAssignmentInventory({
      sandboxId: SANDBOX_ID,
      dockerCommand: "fake-docker",
    });

    await expect(inventory.listAssignments()).resolves.toEqual([observed.assignment]);
    queuedResults.push(
      { code: 0, stdout: observed.raw },
      { code: 0, stdout: RUNTIME_ID },
      { code: 1, stderr: `Error: No such container: ${RUNTIME_ID}` },
    );
    await expect(inventory.terminateAndConfirmAbsent(observed.assignment)).resolves.toBeUndefined();

    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      expect.arrayContaining(["ps", `label=agent-dock.sandbox-id=${SANDBOX_ID}`, "{{.ID}}"]),
      ["inspect", RUNTIME_ID],
      ["inspect", RUNTIME_ID],
      ["rm", "--force", RUNTIME_ID],
      ["inspect", RUNTIME_ID],
    ]);
  });

  it("refuses termination when the labels changed after inventory", async () => {
    const original = inspection();
    const changed = inspection({
      "agent-dock.command-id": "20000000-0000-4000-8000-000000000099",
    });
    queuedResults.push({ code: 0, stdout: changed.raw });
    const inventory = new DockerSandboxAssignmentInventory({
      sandboxId: SANDBOX_ID,
      dockerCommand: "fake-docker",
    });

    await expect(inventory.terminateAndConfirmAbsent(original.assignment)).rejects.toMatchObject({
      code: "docker_assignment_identity_mismatch",
      retryable: false,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on incomplete labels instead of guessing ownership", async () => {
    const malformed = inspection();
    const parsed = JSON.parse(malformed.raw) as Array<{
      Config: { Labels: Record<string, string> };
    }>;
    delete parsed[0]!.Config.Labels["agent-dock.lease-id"];
    queuedResults.push(
      { code: 0, stdout: `${RUNTIME_ID}\n` },
      { code: 0, stdout: JSON.stringify(parsed) },
    );
    const inventory = new DockerSandboxAssignmentInventory({
      sandboxId: SANDBOX_ID,
      dockerCommand: "fake-docker",
    });

    await expect(inventory.listAssignments()).rejects.toMatchObject({
      code: "docker_assignment_identity_invalid",
      retryable: false,
    });
  });
});
