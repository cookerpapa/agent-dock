import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

export const TOOL_BROKER_SANDBOX_PREVIEW_PATH = "/internal/v1/sandbox-preview" as const;
// Cube permits three custom exposed ports per template. The trusted Tool Service
// owns 49984, leaving two product-facing application ports.
export const SANDBOX_PREVIEW_PORTS = Object.freeze([3000, 8000] as const);
const SandboxPreviewPortSchema = Type.Union([Type.Literal(3000), Type.Literal(8000)]);

const PreviewHeadersSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z0-9-]+$" }),
  Type.String({ maxLength: 8_192 }),
  { maxProperties: 32 },
);

export const SandboxPreviewTargetSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("conversation"), sessionId: UuidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("development_environment"), environmentId: UuidSchema },
    { additionalProperties: false },
  ),
]);

export const SandboxPreviewRequestSchema = Type.Object(
  {
    sandboxPreviewProtocolVersion: Type.Literal(1),
    type: Type.Literal("sandbox_preview.request"),
    requestId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    target: SandboxPreviewTargetSchema,
    port: SandboxPreviewPortSchema,
    method: Type.Union([
      Type.Literal("GET"),
      Type.Literal("HEAD"),
      Type.Literal("POST"),
      Type.Literal("PUT"),
      Type.Literal("PATCH"),
      Type.Literal("DELETE"),
      Type.Literal("OPTIONS"),
    ]),
    path: Type.String({ minLength: 1, maxLength: 8_192, pattern: "^/" }),
    headers: PreviewHeadersSchema,
    body: Type.Optional(Type.String({ maxLength: 24 * 1_024 * 1_024 })),
  },
  { additionalProperties: false },
);

export const SandboxPreviewResponseSchema = Type.Union([
  Type.Object(
    {
      sandboxPreviewProtocolVersion: Type.Literal(1),
      type: Type.Literal("sandbox_preview.response"),
      requestId: UuidSchema,
      status: Type.Integer({ minimum: 100, maximum: 599 }),
      headers: PreviewHeadersSchema,
      body: Type.String({ maxLength: 24 * 1_024 * 1_024 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      sandboxPreviewProtocolVersion: Type.Literal(1),
      type: Type.Literal("sandbox_preview.owner_redirect"),
      requestId: UuidSchema,
      ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
    },
    { additionalProperties: false },
  ),
]);

export type SandboxPreviewTarget = Static<typeof SandboxPreviewTargetSchema>;
export type SandboxPreviewRequest = Static<typeof SandboxPreviewRequestSchema>;
export type SandboxPreviewResponse = Static<typeof SandboxPreviewResponseSchema>;

export class SandboxPreviewProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPreviewProtocolError";
  }
}

function parse<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) throw new SandboxPreviewProtocolError(`${label} was invalid`);
  return value as Static<Schema>;
}

export function parseSandboxPreviewRequest(value: unknown): SandboxPreviewRequest {
  return parse(SandboxPreviewRequestSchema, value, "Sandbox preview request");
}

export function parseSandboxPreviewResponse(value: unknown): SandboxPreviewResponse {
  return parse(SandboxPreviewResponseSchema, value, "Sandbox preview response");
}
