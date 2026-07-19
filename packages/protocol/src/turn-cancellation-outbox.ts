import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

export const TURN_CANCELLATION_OUTBOX_TOPIC = "control.command.cancel.pending.v1";

export const TurnCancellationOutboxPayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    commandId: UuidSchema,
    targetCommandId: UuidSchema,
    sessionId: UuidSchema,
    turnId: UuidSchema,
    kind: Type.Literal("turn.cancel"),
  },
  { additionalProperties: false },
);

export type TurnCancellationOutboxPayload = Static<typeof TurnCancellationOutboxPayloadSchema>;

export class TurnCancellationOutboxProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnCancellationOutboxProtocolError";
  }
}

export function parseTurnCancellationOutboxPayload(value: unknown): TurnCancellationOutboxPayload {
  if (!Value.Check(TurnCancellationOutboxPayloadSchema, value)) {
    const issue = [...Value.Errors(TurnCancellationOutboxPayloadSchema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new TurnCancellationOutboxProtocolError(
      `Invalid turn-cancellation outbox payload at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value;
}
