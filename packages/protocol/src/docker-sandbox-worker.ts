import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { TurnCancellationReasonSchema } from "./event-envelope.ts";
import { DeepSeekModelIdSchema } from "./control-plane-api.ts";
import {
  EventAckMessageSchema,
  EventPublishMessageSchema,
  ExecuteTurnCommandMessageSchema,
} from "./supervisor-wire.ts";

export const MAX_PI_SESSION_SNAPSHOT_BYTES = 2 * 1_024 * 1_024;
export const MAX_WORKSPACE_SNAPSHOT_BYTES = 2 * 1_024 * 1_024;

const MAX_BASE64_SNAPSHOT_LENGTH =
  Math.ceil(Math.max(MAX_PI_SESSION_SNAPSHOT_BYTES, MAX_WORKSPACE_SNAPSHOT_BYTES) / 3) * 4;

const SandboxWorkerEnvelopeProperties = {
  sandboxProtocolVersion: Type.Literal(1),
};

const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const CheckpointRevisionSchema = Type.String({ minLength: 1, maxLength: 256 });

export const DockerSandboxModelRuntimeSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("embedded_fake"),
      scenario: Type.Union([
        Type.Literal("java_repair"),
        Type.Literal("java_followup"),
        Type.Literal("timeout"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("openai_compatible_gateway"),
      provider: Type.Literal("deepseek"),
      modelId: DeepSeekModelIdSchema,
      baseUrl: Type.String({ minLength: 12, maxLength: 2_048 }),
      capability: Type.String({ pattern: "^admg_[A-Za-z0-9_-]{43}$" }),
      reasoning: Type.Boolean(),
      contextWindow: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
      maxTokens: Type.Integer({ minimum: 128, maximum: 65_536 }),
      requestTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
      turnTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 900_000 }),
    },
    { additionalProperties: false },
  ),
]);

export const SandboxCheckpointBlobSchema = Type.Object(
  {
    encoding: Type.Literal("base64"),
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_PI_SESSION_SNAPSHOT_BYTES }),
    data: Type.String({ minLength: 4, maxLength: MAX_BASE64_SNAPSHOT_LENGTH }),
  },
  { additionalProperties: false },
);

export const SandboxSettledCheckpointSchema = Type.Object(
  {
    format: Type.Literal("agent-dock.settled-checkpoint.v1"),
    piSession: SandboxCheckpointBlobSchema,
    workspace: SandboxCheckpointBlobSchema,
  },
  { additionalProperties: false },
);

const SandboxCheckpointIdentityProperties = {
  commandId: Type.String({ minLength: 1, maxLength: 256 }),
  sessionId: Type.String({ minLength: 1, maxLength: 256 }),
  turnId: Type.String({ minLength: 1, maxLength: 256 }),
  leaseId: Type.String({ minLength: 1, maxLength: 256 }),
  fencingToken: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};

export const DockerSandboxRunMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.run"),
    command: ExecuteTurnCommandMessageSchema,
    runtime: DockerSandboxModelRuntimeSchema,
    workspaceFixture: Type.Literal("java-repair"),
    checkpoint: Type.Union([
      Type.Object({ mode: Type.Literal("disabled") }, { additionalProperties: false }),
      Type.Object(
        {
          mode: Type.Literal("settled"),
          baseRevision: Type.Union([Type.Null(), CheckpointRevisionSchema]),
          restore: Type.Optional(SandboxSettledCheckpointSchema),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export const DockerSandboxCheckpointAckMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.checkpoint.ack"),
    ...SandboxCheckpointIdentityProperties,
    revision: CheckpointRevisionSchema,
  },
  { additionalProperties: false },
);

export const DockerSandboxCancelMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.cancel"),
    reason: TurnCancellationReasonSchema,
    gracePeriodMs: Type.Integer({ minimum: 0, maximum: 30_000 }),
  },
  { additionalProperties: false },
);

export const DockerSandboxWorkerInputSchema = Type.Union([
  DockerSandboxRunMessageSchema,
  DockerSandboxCancelMessageSchema,
  DockerSandboxCheckpointAckMessageSchema,
  EventAckMessageSchema,
]);

export const DockerSandboxReadyMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.ready"),
    piVersion: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$", maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const DockerSandboxResultMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.result"),
    stopReason: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export const DockerSandboxCheckpointPublishMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.checkpoint.publish"),
    ...SandboxCheckpointIdentityProperties,
    baseRevision: Type.Union([Type.Null(), CheckpointRevisionSchema]),
    checkpoint: SandboxSettledCheckpointSchema,
  },
  { additionalProperties: false },
);

export const DockerSandboxCancelledMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.cancelled"),
    reason: TurnCancellationReasonSchema,
    forced: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const DockerSandboxFailedMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.failed"),
    code: Type.String({ minLength: 1, maxLength: 256 }),
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const DockerSandboxWorkerOutputSchema = Type.Union([
  DockerSandboxReadyMessageSchema,
  EventPublishMessageSchema,
  DockerSandboxCheckpointPublishMessageSchema,
  DockerSandboxResultMessageSchema,
  DockerSandboxCancelledMessageSchema,
  DockerSandboxFailedMessageSchema,
]);

export type DockerSandboxRunMessage = Static<typeof DockerSandboxRunMessageSchema>;
export type DockerSandboxModelRuntime = Static<typeof DockerSandboxModelRuntimeSchema>;
export type DockerSandboxCancelMessage = Static<typeof DockerSandboxCancelMessageSchema>;
export type DockerSandboxCheckpointAckMessage = Static<
  typeof DockerSandboxCheckpointAckMessageSchema
>;
export type DockerSandboxWorkerInput = Static<typeof DockerSandboxWorkerInputSchema>;
export type DockerSandboxReadyMessage = Static<typeof DockerSandboxReadyMessageSchema>;
export type DockerSandboxCheckpointPublishMessage = Static<
  typeof DockerSandboxCheckpointPublishMessageSchema
>;
export type DockerSandboxResultMessage = Static<typeof DockerSandboxResultMessageSchema>;
export type DockerSandboxCancelledMessage = Static<typeof DockerSandboxCancelledMessageSchema>;
export type DockerSandboxFailedMessage = Static<typeof DockerSandboxFailedMessageSchema>;
export type DockerSandboxWorkerOutput = Static<typeof DockerSandboxWorkerOutputSchema>;
export type SandboxCheckpointBlob = Static<typeof SandboxCheckpointBlobSchema>;
export type SandboxSettledCheckpoint = Static<typeof SandboxSettledCheckpointSchema>;

export class DockerSandboxWorkerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerSandboxWorkerProtocolError";
  }
}

function parseWithSchema<T>(schema: object, value: unknown, direction: string): T {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new DockerSandboxWorkerProtocolError(
      `Invalid Docker sandbox ${direction} message at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as T;
}

export function parseDockerSandboxWorkerInput(value: unknown): DockerSandboxWorkerInput {
  return parseWithSchema(DockerSandboxWorkerInputSchema, value, "input");
}

export function parseDockerSandboxWorkerOutput(value: unknown): DockerSandboxWorkerOutput {
  return parseWithSchema(DockerSandboxWorkerOutputSchema, value, "output");
}
