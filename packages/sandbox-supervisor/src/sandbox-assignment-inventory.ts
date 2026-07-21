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

function boundedIdentity(value: string, name: string): string {
  if (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function validateSandboxRuntimeIdentity(
  value: SandboxRuntimeIdentity,
): SandboxRuntimeIdentity {
  const supervisorId = boundedIdentity(value.supervisorId, "supervisorId");
  const bootId = boundedIdentity(value.bootId, "bootId");
  const sandboxId = boundedIdentity(value.sandboxId, "sandboxId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bootId)) {
    throw new TypeError("bootId must be a UUID");
  }
  return { supervisorId, bootId, sandboxId };
}
