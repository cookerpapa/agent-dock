import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

export const TurnThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const IdempotencyKeySchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const TenantApiRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);

export const TenantIdentityResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    tenantSlug: Type.String({ minLength: 1, maxLength: 256 }),
    userId: UuidSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    role: TenantApiRoleSchema,
  },
  { additionalProperties: false },
);

export const CreateProjectRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export const ProjectResourceSchema = Type.Object(
  {
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const CreateSessionRequestSchema = Type.Object(
  {
    workspaceId: UuidSchema,
  },
  { additionalProperties: false },
);

export const SessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    state: Type.Literal("cold"),
    modelProfileId: UuidSchema,
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const AcceptTurnRequestSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    thinkingLevel: Type.Optional(TurnThinkingLevelSchema),
  },
  { additionalProperties: false },
);

export const AcceptedTurnResourceSchema = Type.Object(
  {
    turnId: UuidSchema,
    sessionId: UuidSchema,
    commandId: UuidSchema,
    mailboxPosition: PositiveSafeIntegerSchema,
    state: Type.Literal("queued"),
    acceptedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CreateTurnCancellationRequestSchema = Type.Object(
  {
    gracePeriodMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  },
  { additionalProperties: false },
);

export const AcceptedTurnCancellationResourceSchema = Type.Object(
  {
    commandId: UuidSchema,
    targetCommandId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    state: Type.Literal("pending"),
    acceptedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ControlPlaneApiErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 128 }),
        message: Type.String({ minLength: 1, maxLength: 1_024 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type TurnThinkingLevel = Static<typeof TurnThinkingLevelSchema>;
export type TenantApiRole = Static<typeof TenantApiRoleSchema>;
export type TenantIdentityResource = Static<typeof TenantIdentityResourceSchema>;
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;
export type ProjectResource = Static<typeof ProjectResourceSchema>;
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type SessionResource = Static<typeof SessionResourceSchema>;
export type AcceptTurnRequest = Static<typeof AcceptTurnRequestSchema>;
export type AcceptedTurnResource = Static<typeof AcceptedTurnResourceSchema>;
export type CreateTurnCancellationRequest = Static<typeof CreateTurnCancellationRequestSchema>;
export type AcceptedTurnCancellationResource = Static<
  typeof AcceptedTurnCancellationResourceSchema
>;
export type ControlPlaneApiError = Static<typeof ControlPlaneApiErrorSchema>;

export class ControlPlaneApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneApiValidationError";
  }
}

function parseSchema<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  description: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new ControlPlaneApiValidationError(
      `Invalid ${description} at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as Static<Schema>;
}

export function parseCreateProjectRequest(value: unknown): CreateProjectRequest {
  const request = parseSchema(CreateProjectRequestSchema, value, "create-project request");
  const name = request.name.trim();
  if (name.length === 0) {
    throw new ControlPlaneApiValidationError(
      "Project name must contain a non-whitespace character",
    );
  }
  return { name };
}

export function parseTenantIdentityResource(value: unknown): TenantIdentityResource {
  return parseSchema(TenantIdentityResourceSchema, value, "tenant identity resource");
}

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  return parseSchema(CreateSessionRequestSchema, value, "create-session request");
}

export function parseAcceptTurnRequest(value: unknown): AcceptTurnRequest {
  const request = parseSchema(AcceptTurnRequestSchema, value, "accept-turn request");
  if (request.prompt.trim().length === 0) {
    throw new ControlPlaneApiValidationError("Turn prompt must contain a non-whitespace character");
  }
  return request;
}

export function parseCreateTurnCancellationRequest(value: unknown): CreateTurnCancellationRequest {
  return parseSchema(
    CreateTurnCancellationRequestSchema,
    value,
    "create-turn-cancellation request",
  );
}

export function parseProjectResource(value: unknown): ProjectResource {
  return parseSchema(ProjectResourceSchema, value, "project resource");
}

export function parseSessionResource(value: unknown): SessionResource {
  return parseSchema(SessionResourceSchema, value, "session resource");
}

export function parseAcceptedTurnResource(value: unknown): AcceptedTurnResource {
  return parseSchema(AcceptedTurnResourceSchema, value, "accepted-turn resource");
}

export function parseAcceptedTurnCancellationResource(
  value: unknown,
): AcceptedTurnCancellationResource {
  return parseSchema(
    AcceptedTurnCancellationResourceSchema,
    value,
    "accepted-turn-cancellation resource",
  );
}

export function parseControlPlaneApiError(value: unknown): ControlPlaneApiError {
  return parseSchema(ControlPlaneApiErrorSchema, value, "control-plane API error");
}

export function parseIdempotencyKey(value: unknown): string {
  return parseSchema(IdempotencyKeySchema, value, "Idempotency-Key header");
}

export function parseUuidPathParameter(value: unknown, name: string): string {
  return parseSchema(UuidSchema, value, `${name} path parameter`);
}

export function parseLastEventIdHeader(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new ControlPlaneApiValidationError(
      "Last-Event-ID must be a canonical non-negative integer",
    );
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new ControlPlaneApiValidationError(
      "Last-Event-ID is outside the supported integer range",
    );
  }
  return sequence;
}
