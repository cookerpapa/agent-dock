import { execFile } from "node:child_process";

const DEFAULT_DOCKER_INVENTORY_TIMEOUT_MS = 10_000;
const MAX_DOCKER_INVENTORY_ITEMS = 1_000;
const MAX_DOCKER_OUTPUT_BYTES = 4 * 1_024 * 1_024;

export const DOCKER_SANDBOX_LABELS = {
  managed: "agent-dock.managed",
  supervisorId: "agent-dock.supervisor-id",
  bootId: "agent-dock.boot-id",
  sandboxId: "agent-dock.sandbox-id",
  commandId: "agent-dock.command-id",
  sessionId: "agent-dock.session-id",
  turnId: "agent-dock.turn-id",
  leaseId: "agent-dock.lease-id",
  fencingToken: "agent-dock.fencing-token",
} as const;

export type SandboxRuntimeIdentity = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
};

export type SandboxRuntimeAssignment = SandboxRuntimeIdentity & {
  runtimeId: string;
  runtimeName: string;
  commandId: string;
  sessionId: string;
  turnId: string;
  leaseId: string;
  fencingToken: number;
};

export interface SandboxAssignmentInventory {
  listAssignments(): Promise<readonly SandboxRuntimeAssignment[]>;
  terminateAndConfirmAbsent(assignment: SandboxRuntimeAssignment): Promise<void>;
}

export type DockerSandboxAssignmentInventoryOptions = {
  sandboxId: string;
  dockerCommand?: string;
  timeoutMs?: number;
};

export class SandboxAssignmentInventoryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SandboxAssignmentInventoryError";
    this.code = code;
    this.retryable = retryable;
  }
}

type DockerInspection = {
  Id?: unknown;
  Name?: unknown;
  Config?: {
    Labels?: unknown;
  };
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function labelValue(value: string, name: string): string {
  if (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is not a safe Docker label value`);
  }
  return value;
}

export function validateSandboxRuntimeIdentity(
  value: SandboxRuntimeIdentity,
): SandboxRuntimeIdentity {
  const supervisorId = labelValue(value.supervisorId, "supervisorId");
  const bootId = labelValue(value.bootId, "bootId");
  const sandboxId = labelValue(value.sandboxId, "sandboxId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bootId)) {
    throw new TypeError("bootId must be a UUID");
  }
  return { supervisorId, bootId, sandboxId };
}

function requiredLabel(labels: Record<string, unknown>, key: string): string {
  const value = labels[key];
  if (typeof value !== "string") {
    throw new SandboxAssignmentInventoryError(
      "docker_assignment_identity_invalid",
      "Managed Docker sandbox labels were incomplete",
      false,
    );
  }
  try {
    return labelValue(value, key);
  } catch {
    throw new SandboxAssignmentInventoryError(
      "docker_assignment_identity_invalid",
      "Managed Docker sandbox labels were invalid",
      false,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound(stderr: string): boolean {
  return /no such (?:object|container)/i.test(stderr);
}

function sameAssignment(left: SandboxRuntimeAssignment, right: SandboxRuntimeAssignment): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.runtimeName === right.runtimeName &&
    left.supervisorId === right.supervisorId &&
    left.bootId === right.bootId &&
    left.sandboxId === right.sandboxId &&
    left.commandId === right.commandId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.leaseId === right.leaseId &&
    left.fencingToken === right.fencingToken
  );
}

function executeDocker(
  dockerCommand: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      dockerCommand,
      [...args],
      { encoding: "utf8", maxBuffer: MAX_DOCKER_OUTPUT_BYTES, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          rejectPromise(
            new SandboxAssignmentInventoryError(
              "docker_inventory_unavailable",
              "Docker sandbox inventory was unavailable",
              true,
            ),
          );
          return;
        }
        resolvePromise({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function parseInspection(value: string, expectedSandboxId: string): SandboxRuntimeAssignment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SandboxAssignmentInventoryError(
      "docker_inventory_malformed",
      "Docker returned malformed sandbox inventory",
      false,
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new SandboxAssignmentInventoryError(
      "docker_inventory_malformed",
      "Docker returned an ambiguous sandbox inspection",
      false,
    );
  }
  const inspection = parsed[0] as DockerInspection;
  if (
    typeof inspection.Id !== "string" ||
    !/^[a-z0-9]{12,128}$/i.test(inspection.Id) ||
    typeof inspection.Name !== "string" ||
    inspection.Name.length < 2 ||
    !isRecord(inspection.Config?.Labels)
  ) {
    throw new SandboxAssignmentInventoryError(
      "docker_assignment_identity_invalid",
      "Managed Docker sandbox identity was invalid",
      false,
    );
  }
  const labels = inspection.Config.Labels;
  const managed = requiredLabel(labels, DOCKER_SANDBOX_LABELS.managed);
  const sandboxId = requiredLabel(labels, DOCKER_SANDBOX_LABELS.sandboxId);
  const fenceText = requiredLabel(labels, DOCKER_SANDBOX_LABELS.fencingToken);
  const fencingToken = Number(fenceText);
  if (
    managed !== "true" ||
    sandboxId !== expectedSandboxId ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1
  ) {
    throw new SandboxAssignmentInventoryError(
      "docker_assignment_identity_invalid",
      "Managed Docker sandbox identity did not match its inventory scope",
      false,
    );
  }
  return {
    runtimeId: inspection.Id,
    runtimeName: inspection.Name.replace(/^\//, ""),
    supervisorId: requiredLabel(labels, DOCKER_SANDBOX_LABELS.supervisorId),
    bootId: requiredLabel(labels, DOCKER_SANDBOX_LABELS.bootId),
    sandboxId,
    commandId: requiredLabel(labels, DOCKER_SANDBOX_LABELS.commandId),
    sessionId: requiredLabel(labels, DOCKER_SANDBOX_LABELS.sessionId),
    turnId: requiredLabel(labels, DOCKER_SANDBOX_LABELS.turnId),
    leaseId: requiredLabel(labels, DOCKER_SANDBOX_LABELS.leaseId),
    fencingToken,
  };
}

export class DockerSandboxAssignmentInventory implements SandboxAssignmentInventory {
  readonly #sandboxId: string;
  readonly #dockerCommand: string;
  readonly #timeoutMs: number;

  constructor(options: DockerSandboxAssignmentInventoryOptions) {
    this.#sandboxId = labelValue(options.sandboxId, "sandboxId");
    this.#dockerCommand = options.dockerCommand ?? "docker";
    if (this.#dockerCommand.trim().length === 0) {
      throw new TypeError("dockerCommand must not be empty");
    }
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_DOCKER_INVENTORY_TIMEOUT_MS,
      "timeoutMs",
    );
  }

  async inspectAssignment(reference: string): Promise<SandboxRuntimeAssignment | undefined> {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(reference)) {
      throw new TypeError("Docker sandbox reference is invalid");
    }
    const result = await executeDocker(
      this.#dockerCommand,
      ["inspect", reference],
      this.#timeoutMs,
    );
    if (result.code !== 0) {
      if (notFound(result.stderr)) return undefined;
      throw new SandboxAssignmentInventoryError(
        "docker_inventory_unverified",
        "Docker sandbox identity could not be verified",
        true,
      );
    }
    return parseInspection(result.stdout, this.#sandboxId);
  }

  async listAssignments(): Promise<readonly SandboxRuntimeAssignment[]> {
    const result = await executeDocker(
      this.#dockerCommand,
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${DOCKER_SANDBOX_LABELS.managed}=true`,
        "--filter",
        `label=${DOCKER_SANDBOX_LABELS.sandboxId}=${this.#sandboxId}`,
        "--format",
        "{{.ID}}",
      ],
      this.#timeoutMs,
    );
    if (result.code !== 0) {
      throw new SandboxAssignmentInventoryError(
        "docker_inventory_unavailable",
        "Docker sandbox inventory failed",
        true,
      );
    }
    const references = result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (
      references.length > MAX_DOCKER_INVENTORY_ITEMS ||
      new Set(references).size !== references.length
    ) {
      throw new SandboxAssignmentInventoryError(
        "docker_inventory_ambiguous",
        "Docker sandbox inventory exceeded its safe scope",
        false,
      );
    }
    const assignments: SandboxRuntimeAssignment[] = [];
    for (const reference of references) {
      const assignment = await this.inspectAssignment(reference);
      if (assignment === undefined) continue;
      assignments.push(assignment);
    }
    return assignments;
  }

  async terminateAndConfirmAbsent(assignment: SandboxRuntimeAssignment): Promise<void> {
    if (assignment.sandboxId !== this.#sandboxId) {
      throw new SandboxAssignmentInventoryError(
        "docker_assignment_identity_mismatch",
        "Docker sandbox termination escaped its inventory scope",
        false,
      );
    }
    const current = await this.inspectAssignment(assignment.runtimeId);
    if (current === undefined) return;
    if (!sameAssignment(current, assignment)) {
      throw new SandboxAssignmentInventoryError(
        "docker_assignment_identity_mismatch",
        "Docker sandbox identity changed before termination",
        false,
      );
    }
    const removal = await executeDocker(
      this.#dockerCommand,
      ["rm", "--force", assignment.runtimeId],
      this.#timeoutMs,
    );
    if (removal.code !== 0 && !notFound(removal.stderr)) {
      throw new SandboxAssignmentInventoryError(
        "docker_assignment_termination_failed",
        "Docker sandbox termination failed",
        true,
      );
    }
    if ((await this.inspectAssignment(assignment.runtimeId)) !== undefined) {
      throw new SandboxAssignmentInventoryError(
        "docker_assignment_still_alive",
        "Docker sandbox termination could not be confirmed",
        false,
      );
    }
  }
}
