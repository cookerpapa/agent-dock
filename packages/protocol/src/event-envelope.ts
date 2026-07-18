import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  OpaqueIdSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

export const SessionStateSchema = Type.Union([
  Type.Literal("cold"),
  Type.Literal("starting"),
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("cancelling"),
  Type.Literal("failed"),
  Type.Literal("recovering"),
  Type.Literal("evicting"),
]);

const CommonEnvelopeProperties = {
  schemaVersion: Type.Literal(1),
  eventId: UuidSchema,
  sessionId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  seq: PositiveSafeIntegerSchema,
  occurredAt: UtcTimestampSchema,
};

const TurnEnvelopeProperties = {
  ...CommonEnvelopeProperties,
  turnId: OpaqueIdSchema,
};

const SessionEnvelopeProperties = {
  ...CommonEnvelopeProperties,
  turnId: Type.Union([OpaqueIdSchema, Type.Null()]),
};

const TurnStartedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("turn.started"),
    payload: Type.Object(
      {
        inputKind: Type.Union([Type.Literal("prompt"), Type.Literal("continue")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const SessionStateChangedEventSchema = Type.Object(
  {
    ...SessionEnvelopeProperties,
    type: Type.Literal("session.state.changed"),
    payload: Type.Object(
      {
        from: SessionStateSchema,
        to: SessionStateSchema,
        reason: Type.Optional(Type.String({ maxLength: 1_024 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const AssistantTextDeltaEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("assistant.text.delta"),
    payload: Type.Object(
      {
        text: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolStartedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("tool.started"),
    payload: Type.Object(
      {
        toolCallId: OpaqueIdSchema,
        toolName: OpaqueIdSchema,
        input: Type.Unknown(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolCompletedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("tool.completed"),
    payload: Type.Object(
      {
        toolCallId: OpaqueIdSchema,
        isError: Type.Boolean(),
        output: Type.Optional(Type.Unknown()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ConfirmApprovalPayloadSchema = Type.Object(
  {
    approvalId: UuidSchema,
    kind: Type.Literal("confirm"),
    title: Type.String({ maxLength: 4_096 }),
    message: Type.String({ maxLength: 16_384 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const SelectApprovalPayloadSchema = Type.Object(
  {
    approvalId: UuidSchema,
    kind: Type.Literal("select"),
    title: Type.String({ maxLength: 4_096 }),
    options: Type.Array(Type.String({ maxLength: 4_096 }), { minItems: 1, maxItems: 100 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const InputApprovalPayloadSchema = Type.Object(
  {
    approvalId: UuidSchema,
    kind: Type.Literal("input"),
    title: Type.String({ maxLength: 4_096 }),
    placeholder: Type.Optional(Type.String({ maxLength: 4_096 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const EditorApprovalPayloadSchema = Type.Object(
  {
    approvalId: UuidSchema,
    kind: Type.Literal("editor"),
    title: Type.String({ maxLength: 4_096 }),
    initialValue: Type.Optional(Type.String({ maxLength: 100_000 })),
  },
  { additionalProperties: false },
);

const ApprovalRequestedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("approval.requested"),
    payload: Type.Union([
      ConfirmApprovalPayloadSchema,
      SelectApprovalPayloadSchema,
      InputApprovalPayloadSchema,
      EditorApprovalPayloadSchema,
    ]),
  },
  { additionalProperties: false },
);

const ApprovalResolvedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("approval.resolved"),
    payload: Type.Object(
      {
        approvalId: UuidSchema,
        outcome: Type.Union([
          Type.Literal("approved"),
          Type.Literal("rejected"),
          Type.Literal("cancelled"),
        ]),
        value: Type.Optional(Type.String({ maxLength: 100_000 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const UiNotificationEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("ui.notification"),
    payload: Type.Object(
      {
        message: Type.String({ maxLength: 16_384 }),
        level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const TurnCompletedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("turn.completed"),
    payload: Type.Object(
      {
        stopReason: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const TurnFailedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("turn.failed"),
    payload: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 256 }),
        message: Type.String({ maxLength: 16_384 }),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AgentDockEventSchema = Type.Union([
  TurnStartedEventSchema,
  SessionStateChangedEventSchema,
  AssistantTextDeltaEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  UiNotificationEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
]);

export type AgentDockEvent =
  | Static<typeof TurnStartedEventSchema>
  | Static<typeof SessionStateChangedEventSchema>
  | Static<typeof AssistantTextDeltaEventSchema>
  | Static<typeof ToolStartedEventSchema>
  | Static<typeof ToolCompletedEventSchema>
  | Static<typeof ApprovalRequestedEventSchema>
  | Static<typeof ApprovalResolvedEventSchema>
  | Static<typeof UiNotificationEventSchema>
  | Static<typeof TurnCompletedEventSchema>
  | Static<typeof TurnFailedEventSchema>;
export type AgentDockEventType = AgentDockEvent["type"];

type EventBody<Event> = Event extends AgentDockEvent ? Pick<Event, "type" | "payload"> : never;
export type AgentDockEventBody = EventBody<AgentDockEvent>;

export class AgentDockProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDockProtocolError";
  }
}

export function parseAgentDockEvent(value: unknown): AgentDockEvent {
  if (!Value.Check(AgentDockEventSchema, value)) {
    const issue = [...Value.Errors(AgentDockEventSchema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new AgentDockProtocolError(
      `Invalid AgentDock event at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as AgentDockEvent;
}

export type AgentDockEventIdentity = {
  sessionId: string;
  turnId: string | null;
  agentId: string;
};

export type AgentDockEventFactoryOptions = {
  initialSequence?: number;
  clock?: () => Date;
  idGenerator?: () => string;
};

export type AgentDockEventFactory = {
  next: (body: AgentDockEventBody) => AgentDockEvent;
  currentSequence: () => number;
};

export function createAgentDockEventFactory(
  identity: AgentDockEventIdentity,
  options: AgentDockEventFactoryOptions = {},
): AgentDockEventFactory {
  let sequence = options.initialSequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new AgentDockProtocolError("initialSequence must be a non-negative safe integer");
  }

  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());

  return {
    next(body) {
      const nextSequence = sequence + 1;
      const event = parseAgentDockEvent({
        schemaVersion: 1,
        eventId: idGenerator(),
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        agentId: identity.agentId,
        seq: nextSequence,
        occurredAt: clock().toISOString(),
        type: body.type,
        payload: body.payload,
      });
      sequence = nextSequence;
      return event;
    },
    currentSequence() {
      return sequence;
    },
  };
}
