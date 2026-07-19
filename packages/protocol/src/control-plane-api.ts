import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";
import { SessionStateSchema } from "./event-envelope.ts";

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

export const DeepSeekModelIdSchema = Type.Union([
  Type.Literal("deepseek-v4-flash"),
  Type.Literal("deepseek-v4-pro"),
]);

export const ReplaceModelConfigurationRequestSchema = Type.Object(
  {
    provider: Type.Literal("deepseek"),
    modelId: DeepSeekModelIdSchema,
    apiKey: Type.String({
      minLength: 16,
      maxLength: 512,
      pattern: "^[A-Za-z0-9._-]+$",
    }),
  },
  { additionalProperties: false },
);

export const ModelConfigurationResourceSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("deterministic"),
      provider: Type.Literal("agent-dock-fake"),
      modelId: Type.Literal("agent-dock-fake"),
      configured: Type.Literal(false),
      credentialVersion: PositiveSafeIntegerSchema,
      updatedAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("real"),
      provider: Type.Literal("deepseek"),
      modelId: DeepSeekModelIdSchema,
      configured: Type.Literal(true),
      credentialVersion: PositiveSafeIntegerSchema,
      updatedAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
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

export const CreateTenantRegistrationRequestSchema = Type.Object(
  {
    tenantSlug: Type.String({ minLength: 1, maxLength: 128 }),
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export const TenantRegistrationResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    tenantSlug: Type.String({ minLength: 1, maxLength: 64 }),
    userId: UuidSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    role: Type.Literal("owner"),
    apiToken: Type.String({
      minLength: 84,
      maxLength: 297,
      pattern:
        "^adk_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\.[A-Za-z0-9_-]{43,256}$",
    }),
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

export const ConversationTurnStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("dispatching"),
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("cancelling"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const ConversationSummaryResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    projectName: Type.String({ minLength: 1, maxLength: 256 }),
    state: SessionStateSchema,
    turnCount: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationListResourceSchema = Type.Object(
  {
    conversations: Type.Array(ConversationSummaryResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ConversationSessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    state: SessionStateSchema,
    modelProfileId: UuidSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationTurnResourceSchema = Type.Object(
  {
    turnId: UuidSchema,
    commandId: UuidSchema,
    mailboxPosition: PositiveSafeIntegerSchema,
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    state: ConversationTurnStateSchema,
    acceptedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationDetailResourceSchema = Type.Object(
  {
    project: ProjectResourceSchema,
    session: ConversationSessionResourceSchema,
    turns: Type.Array(ConversationTurnResourceSchema, { maxItems: 200 }),
    historyTruncated: Type.Boolean(),
    replayAfterSequence: NonNegativeSafeIntegerSchema,
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
export type DeepSeekModelId = Static<typeof DeepSeekModelIdSchema>;
export type ReplaceModelConfigurationRequest = Static<
  typeof ReplaceModelConfigurationRequestSchema
>;
export type ModelConfigurationResource = Static<typeof ModelConfigurationResourceSchema>;
export type CreateTenantRegistrationRequest = Static<typeof CreateTenantRegistrationRequestSchema>;
export type TenantRegistrationResource = Static<typeof TenantRegistrationResourceSchema>;
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;
export type ProjectResource = Static<typeof ProjectResourceSchema>;
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type SessionResource = Static<typeof SessionResourceSchema>;
export type ConversationTurnState = Static<typeof ConversationTurnStateSchema>;
export type ConversationSummaryResource = Static<typeof ConversationSummaryResourceSchema>;
export type ConversationListResource = Static<typeof ConversationListResourceSchema>;
export type ConversationSessionResource = Static<typeof ConversationSessionResourceSchema>;
export type ConversationTurnResource = Static<typeof ConversationTurnResourceSchema>;
export type ConversationDetailResource = Static<typeof ConversationDetailResourceSchema>;
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

export function parseReplaceModelConfigurationRequest(
  value: unknown,
): ReplaceModelConfigurationRequest {
  return parseSchema(
    ReplaceModelConfigurationRequestSchema,
    value,
    "replace-model-configuration request",
  );
}

export function parseModelConfigurationResource(value: unknown): ModelConfigurationResource {
  return parseSchema(ModelConfigurationResourceSchema, value, "model configuration resource");
}

export function parseCreateTenantRegistrationRequest(
  value: unknown,
): CreateTenantRegistrationRequest {
  const request = parseSchema(
    CreateTenantRegistrationRequestSchema,
    value,
    "tenant registration request",
  );
  const tenantSlug = request.tenantSlug.trim().toLowerCase();
  const displayName = request.displayName.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(tenantSlug)) {
    throw new ControlPlaneApiValidationError(
      "Tenant slug must contain 1-64 lowercase letters, digits, or hyphens",
    );
  }
  if (
    displayName.length === 0 ||
    new TextEncoder().encode(displayName).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new ControlPlaneApiValidationError("Display name must contain 1-256 safe UTF-8 bytes");
  }
  return { tenantSlug, displayName };
}

export function parseTenantRegistrationResource(value: unknown): TenantRegistrationResource {
  return parseSchema(TenantRegistrationResourceSchema, value, "tenant registration resource");
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

export function parseConversationListResource(value: unknown): ConversationListResource {
  return parseSchema(ConversationListResourceSchema, value, "conversation list resource");
}

export function parseConversationDetailResource(value: unknown): ConversationDetailResource {
  return parseSchema(ConversationDetailResourceSchema, value, "conversation detail resource");
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
