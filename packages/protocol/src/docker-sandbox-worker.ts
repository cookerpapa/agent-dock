import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { TurnCancellationReasonSchema } from "./event-envelope.ts";
import {
  EventAckMessageSchema,
  EventPublishMessageSchema,
  ExecuteTurnCommandMessageSchema,
} from "./supervisor-wire.ts";

const SandboxWorkerEnvelopeProperties = {
  sandboxProtocolVersion: Type.Literal(1),
};

export const DockerSandboxRunMessageSchema = Type.Object(
  {
    ...SandboxWorkerEnvelopeProperties,
    type: Type.Literal("sandbox.run"),
    command: ExecuteTurnCommandMessageSchema,
    runtime: Type.Object(
      {
        kind: Type.Literal("embedded_fake"),
        scenario: Type.Union([Type.Literal("java_repair"), Type.Literal("timeout")]),
      },
      { additionalProperties: false },
    ),
    workspaceFixture: Type.Literal("java-repair"),
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
  DockerSandboxResultMessageSchema,
  DockerSandboxCancelledMessageSchema,
  DockerSandboxFailedMessageSchema,
]);

export type DockerSandboxRunMessage = Static<typeof DockerSandboxRunMessageSchema>;
export type DockerSandboxCancelMessage = Static<typeof DockerSandboxCancelMessageSchema>;
export type DockerSandboxWorkerInput = Static<typeof DockerSandboxWorkerInputSchema>;
export type DockerSandboxReadyMessage = Static<typeof DockerSandboxReadyMessageSchema>;
export type DockerSandboxResultMessage = Static<typeof DockerSandboxResultMessageSchema>;
export type DockerSandboxCancelledMessage = Static<typeof DockerSandboxCancelledMessageSchema>;
export type DockerSandboxFailedMessage = Static<typeof DockerSandboxFailedMessageSchema>;
export type DockerSandboxWorkerOutput = Static<typeof DockerSandboxWorkerOutputSchema>;

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
