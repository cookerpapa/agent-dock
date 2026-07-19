export type SupervisorDispatchAffinity = {
  sandboxId: string;
  controlPlaneInstanceId: string;
};

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

export function validateSupervisorDispatchAffinity(
  value: SupervisorDispatchAffinity,
): SupervisorDispatchAffinity {
  return {
    sandboxId: requireUuid(value.sandboxId, "supervisorAffinity.sandboxId"),
    controlPlaneInstanceId: requireUuid(
      value.controlPlaneInstanceId,
      "supervisorAffinity.controlPlaneInstanceId",
    ),
  };
}
