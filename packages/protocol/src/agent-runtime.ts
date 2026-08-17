import { Type, type Static } from "typebox";
import { DeepSeekModelIdSchema } from "./control-plane-api.ts";

// Provider-native Workspace checkpoints carry a bounded file index and an
// encrypted recovery reference. Large filesystem bytes remain in the Provider
// snapshot instead of being base64-inlined into this control message.
export const MAX_WORKSPACE_SNAPSHOT_BYTES = 32 * 1_024 * 1_024;

const MAX_BASE64_SNAPSHOT_LENGTH = Math.ceil(MAX_WORKSPACE_SNAPSHOT_BYTES / 3) * 4;

const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const AgentModelRuntimeSchema = Type.Object(
  {
    kind: Type.Literal("openai_compatible_gateway"),
    provider: Type.Literal("deepseek"),
    modelId: DeepSeekModelIdSchema,
    baseUrl: Type.String({ minLength: 12, maxLength: 2_048 }),
    capability: Type.String({ pattern: "^pcmg_[A-Za-z0-9_-]{43}$" }),
    reasoning: Type.Boolean(),
    contextWindow: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
    maxTokens: Type.Integer({ minimum: 128, maximum: 65_536 }),
    requestTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    turnTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 900_000 }),
  },
  { additionalProperties: false },
);

export const SandboxCheckpointBlobSchema = Type.Object(
  {
    encoding: Type.Literal("base64"),
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({
      minimum: 1,
      maximum: MAX_WORKSPACE_SNAPSHOT_BYTES,
    }),
    data: Type.String({ minLength: 4, maxLength: MAX_BASE64_SNAPSHOT_LENGTH }),
  },
  { additionalProperties: false },
);

export const AgentWorkspaceSeedSchema = Type.Union([
  Type.Object({ kind: Type.Literal("sample_java") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("snapshot"), snapshot: SandboxCheckpointBlobSchema },
    { additionalProperties: false },
  ),
]);

export type AgentModelRuntime = Static<typeof AgentModelRuntimeSchema>;
export type AgentWorkspaceSeed = Static<typeof AgentWorkspaceSeedSchema>;
export type SandboxCheckpointBlob = Static<typeof SandboxCheckpointBlobSchema>;
