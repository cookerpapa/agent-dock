import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

export const TURN_COMMAND_OUTBOX_TOPIC = "control.command.pending.v1";

export const TurnCommandOutboxPayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    commandId: UuidSchema,
    sessionId: UuidSchema,
    turnId: UuidSchema,
    kind: Type.Literal("turn.execute"),
  },
  { additionalProperties: false },
);

export type TurnCommandOutboxPayload = Static<typeof TurnCommandOutboxPayloadSchema>;

export class TurnCommandOutboxProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnCommandOutboxProtocolError";
  }
}

export function parseTurnCommandOutboxPayload(value: unknown): TurnCommandOutboxPayload {
  if (!Value.Check(TurnCommandOutboxPayloadSchema, value)) {
    const issue = [...Value.Errors(TurnCommandOutboxPayloadSchema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new TurnCommandOutboxProtocolError(
      `Invalid turn-command outbox payload at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value;
}
