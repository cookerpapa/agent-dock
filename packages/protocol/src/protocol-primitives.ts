import { Type, type Static } from "typebox";

export const OpaqueIdSchema = Type.String({ minLength: 1, maxLength: 256 });

export const UuidSchema = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});

export const TraceContextSchema = Type.Object(
  {
    traceparent: Type.String({
      pattern: "^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$",
      maxLength: 55,
    }),
    tracestate: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type TraceContext = Static<typeof TraceContextSchema>;

export const UtcTimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});

export const PositiveSafeIntegerSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const NonNegativeSafeIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const SandboxRetentionPolicySchema = Type.Union([
  Type.Literal("ephemeral"),
  Type.Literal("persistent"),
]);
export type SandboxRetentionPolicy = Static<typeof SandboxRetentionPolicySchema>;
