import { OpaqueIdSchema, PositiveSafeIntegerSchema } from "@pi-cloud/protocol";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const ModelThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const ModelProfileSchema = Type.Object(
  {
    profileId: OpaqueIdSchema,
    provider: OpaqueIdSchema,
    modelId: OpaqueIdSchema,
    defaultThinkingLevel: ModelThinkingLevelSchema,
    allowedThinkingLevels: Type.Array(ModelThinkingLevelSchema, {
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
    }),
    credentialBindingId: OpaqueIdSchema,
    credentialBindingVersion: PositiveSafeIntegerSchema,
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ResolvedTurnModelSchema = Type.Object(
  {
    profileId: OpaqueIdSchema,
    provider: OpaqueIdSchema,
    modelId: OpaqueIdSchema,
    thinkingLevel: ModelThinkingLevelSchema,
    credentialBindingId: OpaqueIdSchema,
    credentialBindingVersion: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export type ModelThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
export type ModelProfile = Static<typeof ModelProfileSchema>;
export type ResolvedTurnModel = Static<typeof ResolvedTurnModelSchema>;

export class DomainModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainModelValidationError";
  }
}

export function parseModelProfile(value: unknown): ModelProfile {
  if (!Value.Check(ModelProfileSchema, value)) {
    const issue = [...Value.Errors(ModelProfileSchema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new DomainModelValidationError(
      `Invalid model profile at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  const profile = value as ModelProfile;
  if (!profile.allowedThinkingLevels.includes(profile.defaultThinkingLevel)) {
    throw new DomainModelValidationError(
      "Model profile defaultThinkingLevel must be included in allowedThinkingLevels",
    );
  }
  return profile;
}

export function parseResolvedTurnModel(value: unknown): ResolvedTurnModel {
  if (!Value.Check(ResolvedTurnModelSchema, value)) {
    const issue = [...Value.Errors(ResolvedTurnModelSchema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new DomainModelValidationError(
      `Invalid resolved turn model at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as ResolvedTurnModel;
}

export function resolveTurnModel(
  value: unknown,
  requestedThinkingLevel?: ModelThinkingLevel,
): ResolvedTurnModel {
  const profile = parseModelProfile(value);
  if (!profile.enabled) {
    throw new DomainModelValidationError(`Model profile ${profile.profileId} is disabled`);
  }
  const thinkingLevel = requestedThinkingLevel ?? profile.defaultThinkingLevel;
  if (!profile.allowedThinkingLevels.includes(thinkingLevel)) {
    throw new DomainModelValidationError(
      `Thinking level ${thinkingLevel} is not allowed by model profile ${profile.profileId}`,
    );
  }
  return {
    profileId: profile.profileId,
    provider: profile.provider,
    modelId: profile.modelId,
    thinkingLevel,
    credentialBindingId: profile.credentialBindingId,
    credentialBindingVersion: profile.credentialBindingVersion,
  };
}
