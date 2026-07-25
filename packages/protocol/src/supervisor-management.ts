import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  OpaqueIdSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

const SupervisorBootIdentitySchema = Type.Object(
  {
    supervisorId: OpaqueIdSchema,
    bootId: UuidSchema,
    sandboxId: UuidSchema,
  },
  { additionalProperties: false },
);

export const SupervisorBootProvisionRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(1),
    type: Type.Literal("supervisor.boot.provision"),
    requestId: UuidSchema,
    supervisorId: OpaqueIdSchema,
    bootId: UuidSchema,
    sandboxId: UuidSchema,
    credentialId: UuidSchema,
    credentialSha256: Sha256Schema,
    maxConcurrentSessions: Type.Integer({ minimum: 1, maximum: 256 }),
    managementBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);

export const SupervisorBootProvisionResponseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(1),
    type: Type.Literal("supervisor.boot.provisioned"),
    requestId: UuidSchema,
    supervisorId: OpaqueIdSchema,
    bootId: UuidSchema,
    sandboxId: UuidSchema,
    credentialId: UuidSchema,
    maxConcurrentSessions: Type.Integer({ minimum: 1, maximum: 256 }),
    expiresAt: UtcTimestampSchema,
    idempotent: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SupervisorRuntimeAssignmentSchema = Type.Object(
  {
    containerId: UuidSchema,
    containerName: Type.String({ minLength: 1, maxLength: 128 }),
    supervisorId: OpaqueIdSchema,
    bootId: UuidSchema,
    sandboxId: UuidSchema,
    commandId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    turnId: OpaqueIdSchema,
    leaseId: UuidSchema,
    fencingToken: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const SupervisorManagementRequestSchema = Type.Union([
  Type.Object(
    {
      protocolVersion: Type.Literal(1),
      type: Type.Literal("owner.stop_and_confirm"),
      requestId: UuidSchema,
      identity: SupervisorBootIdentitySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocolVersion: Type.Literal(1),
      type: Type.Literal("assignments.list"),
      requestId: UuidSchema,
      sandboxId: UuidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocolVersion: Type.Literal(1),
      type: Type.Literal("assignment.terminate_and_confirm"),
      requestId: UuidSchema,
      sandboxId: UuidSchema,
      assignment: SupervisorRuntimeAssignmentSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocolVersion: Type.Literal(1),
      type: Type.Literal("assignment.confirm_absent"),
      requestId: UuidSchema,
      sandboxId: UuidSchema,
      assignment: SupervisorRuntimeAssignmentSchema,
    },
    { additionalProperties: false },
  ),
]);

export const SupervisorManagementResponseSchema = Type.Union([
  Type.Object(
    {
      protocolVersion: Type.Literal(1),
      type: Type.Literal("owner.stopped"),
      requestId: UuidSchema,
      identity: SupervisorBootIdentitySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocolVersion: Type.Literal(1),
      type: Type.Literal("assignments.listed"),
      requestId: UuidSchema,
      sandboxId: UuidSchema,
      assignments: Type.Array(SupervisorRuntimeAssignmentSchema, { maxItems: 1_024 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocolVersion: Type.Literal(1),
      type: Type.Literal("assignment.absent"),
      requestId: UuidSchema,
      sandboxId: UuidSchema,
      containerId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export const InternalServiceErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
        }),
        message: Type.String({ minLength: 1, maxLength: 512 }),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type SupervisorBootProvisionRequest = Static<typeof SupervisorBootProvisionRequestSchema>;
export type SupervisorBootProvisionResponse = Static<typeof SupervisorBootProvisionResponseSchema>;
export type SupervisorRuntimeAssignment = Static<typeof SupervisorRuntimeAssignmentSchema>;
export type SupervisorManagementRequest = Static<typeof SupervisorManagementRequestSchema>;
export type SupervisorManagementResponse = Static<typeof SupervisorManagementResponseSchema>;
export type InternalServiceError = Static<typeof InternalServiceErrorSchema>;

export class AgentDockInternalProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDockInternalProtocolError";
  }
}

function parse<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    throw new AgentDockInternalProtocolError(`${label} failed validation`);
  }
  return value as T;
}

export function parseSupervisorBootProvisionRequest(
  value: unknown,
): SupervisorBootProvisionRequest {
  return parse(SupervisorBootProvisionRequestSchema, value, "Supervisor boot provision request");
}

export function parseSupervisorBootProvisionResponse(
  value: unknown,
): SupervisorBootProvisionResponse {
  return parse(SupervisorBootProvisionResponseSchema, value, "Supervisor boot provision response");
}

export function parseSupervisorManagementRequest(value: unknown): SupervisorManagementRequest {
  return parse(SupervisorManagementRequestSchema, value, "Supervisor management request");
}

export function parseSupervisorManagementResponse(value: unknown): SupervisorManagementResponse {
  return parse(SupervisorManagementResponseSchema, value, "Supervisor management response");
}

export function parseInternalServiceError(value: unknown): InternalServiceError {
  return parse(InternalServiceErrorSchema, value, "Internal service error");
}
