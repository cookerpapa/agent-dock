import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AgentDockEventSchema, SessionStateSchema } from "./event-envelope.ts";
import {
  NonNegativeSafeIntegerSchema,
  OpaqueIdSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

const WireEnvelopeProperties = {
  protocolVersion: Type.Literal(1),
  messageId: UuidSchema,
  sentAt: UtcTimestampSchema,
};

const LeaseProperties = {
  leaseId: UuidSchema,
  fencingToken: PositiveSafeIntegerSchema,
};

const CommandIdentityProperties = {
  commandId: UuidSchema,
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  tenantId: OpaqueIdSchema,
  projectId: OpaqueIdSchema,
  workspaceId: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  turnId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  ...LeaseProperties,
};

const RuntimeVersionSchema = Type.String({
  minLength: 5,
  maxLength: 128,
  pattern: "^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$",
});

const CapabilitySchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
});

const PromptInputSchema = Type.Object(
  {
    kind: Type.Literal("prompt"),
    text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  },
  { additionalProperties: false },
);

const ContinueInputSchema = Type.Object(
  {
    kind: Type.Literal("continue"),
  },
  { additionalProperties: false },
);

const ApprovalResolutionSchema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal("approved"),
      value: Type.Optional(Type.String({ maxLength: 100_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("rejected"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      outcome: Type.Literal("cancelled"),
    },
    { additionalProperties: false },
  ),
]);

export const SupervisorRegisterMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.register"),
    payload: Type.Object(
      {
        supervisorId: OpaqueIdSchema,
        bootId: UuidSchema,
        sandboxId: OpaqueIdSchema,
        supervisorVersion: RuntimeVersionSchema,
        pi: Type.Object(
          {
            packageName: Type.String({ minLength: 1, maxLength: 256 }),
            version: RuntimeVersionSchema,
          },
          { additionalProperties: false },
        ),
        supportedProtocolVersions: Type.Array(PositiveSafeIntegerSchema, {
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
        }),
        capabilities: Type.Array(CapabilitySchema, {
          maxItems: 256,
          uniqueItems: true,
        }),
        maxConcurrentSessions: PositiveSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SupervisorRegisteredMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.registered"),
    payload: Type.Object(
      {
        supervisorId: OpaqueIdSchema,
        bootId: UuidSchema,
        connectionId: UuidSchema,
        selectedProtocolVersion: Type.Literal(1),
        heartbeatIntervalMs: PositiveSafeIntegerSchema,
        heartbeatTimeoutMs: PositiveSafeIntegerSchema,
        serverTime: UtcTimestampSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ExecuteTurnCommandMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.turn.execute"),
    payload: Type.Object(
      {
        ...CommandIdentityProperties,
        nextEventSeq: PositiveSafeIntegerSchema,
        input: Type.Union([PromptInputSchema, ContinueInputSchema]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CancelTurnCommandMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.turn.cancel"),
    payload: Type.Object(
      {
        ...CommandIdentityProperties,
        reason: Type.Union([
          Type.Literal("user_request"),
          Type.Literal("timeout"),
          Type.Literal("lease_revoked"),
          Type.Literal("shutdown"),
        ]),
        gracePeriodMs: Type.Optional(NonNegativeSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ResolveApprovalCommandMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.approval.resolve"),
    payload: Type.Object(
      {
        ...CommandIdentityProperties,
        approvalId: UuidSchema,
        decision: ApprovalResolutionSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const CommandAckIdentityProperties = {
  commandId: UuidSchema,
  sessionId: OpaqueIdSchema,
  turnId: OpaqueIdSchema,
  ...LeaseProperties,
};

const AcceptedCommandAckPayloadSchema = Type.Object(
  {
    ...CommandAckIdentityProperties,
    status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  },
  { additionalProperties: false },
);

const RejectedCommandAckPayloadSchema = Type.Object(
  {
    ...CommandAckIdentityProperties,
    status: Type.Literal("rejected"),
    code: Type.Union([
      Type.Literal("stale_fence"),
      Type.Literal("invalid_state"),
      Type.Literal("capacity"),
      Type.Literal("invalid_command"),
      Type.Literal("unsupported"),
    ]),
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CommandAckMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.ack"),
    payload: Type.Union([AcceptedCommandAckPayloadSchema, RejectedCommandAckPayloadSchema]),
  },
  { additionalProperties: false },
);

export const EventPublishMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("event.publish"),
    payload: Type.Object(
      {
        ...LeaseProperties,
        commandId: Type.Optional(UuidSchema),
        event: AgentDockEventSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EventAckMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("event.ack"),
    payload: Type.Object(
      {
        sessionId: OpaqueIdSchema,
        ...LeaseProperties,
        acknowledgedThroughSeq: PositiveSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const HeartbeatSessionSchema = Type.Object(
  {
    sessionId: OpaqueIdSchema,
    turnId: Type.Union([OpaqueIdSchema, Type.Null()]),
    state: SessionStateSchema,
    ...LeaseProperties,
    lastProducedSeq: NonNegativeSafeIntegerSchema,
    lastAcknowledgedSeq: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const SupervisorHeartbeatMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.heartbeat"),
    payload: Type.Object(
      {
        supervisorId: OpaqueIdSchema,
        bootId: UuidSchema,
        connectionId: UuidSchema,
        acceptingAssignments: Type.Boolean(),
        maxConcurrentSessions: PositiveSafeIntegerSchema,
        sessions: Type.Array(HeartbeatSessionSchema, { maxItems: 1_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const LeaseRenewalSchema = Type.Object(
  {
    sessionId: OpaqueIdSchema,
    ...LeaseProperties,
    validUntil: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const SupervisorHeartbeatAckMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.heartbeat.ack"),
    payload: Type.Object(
      {
        acknowledgedMessageId: UuidSchema,
        connectionId: UuidSchema,
        leaseRenewals: Type.Array(LeaseRenewalSchema, { maxItems: 1_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SupervisorToControlMessageSchema = Type.Union([
  SupervisorRegisterMessageSchema,
  CommandAckMessageSchema,
  EventPublishMessageSchema,
  SupervisorHeartbeatMessageSchema,
]);

export const ControlToSupervisorMessageSchema = Type.Union([
  SupervisorRegisteredMessageSchema,
  ExecuteTurnCommandMessageSchema,
  CancelTurnCommandMessageSchema,
  ResolveApprovalCommandMessageSchema,
  EventAckMessageSchema,
  SupervisorHeartbeatAckMessageSchema,
]);

export type SupervisorRegisterMessage = Static<typeof SupervisorRegisterMessageSchema>;
export type SupervisorRegisteredMessage = Static<typeof SupervisorRegisteredMessageSchema>;
export type ExecuteTurnCommandMessage = Static<typeof ExecuteTurnCommandMessageSchema>;
export type CancelTurnCommandMessage = Static<typeof CancelTurnCommandMessageSchema>;
export type ResolveApprovalCommandMessage = Static<typeof ResolveApprovalCommandMessageSchema>;
export type CommandAckMessage = Static<typeof CommandAckMessageSchema>;
export type EventPublishMessage = Static<typeof EventPublishMessageSchema>;
export type EventAckMessage = Static<typeof EventAckMessageSchema>;
export type SupervisorHeartbeatMessage = Static<typeof SupervisorHeartbeatMessageSchema>;
export type SupervisorHeartbeatAckMessage = Static<typeof SupervisorHeartbeatAckMessageSchema>;

export type SupervisorToControlMessage =
  SupervisorRegisterMessage | CommandAckMessage | EventPublishMessage | SupervisorHeartbeatMessage;

export type ControlToSupervisorMessage =
  | SupervisorRegisteredMessage
  | ExecuteTurnCommandMessage
  | CancelTurnCommandMessage
  | ResolveApprovalCommandMessage
  | EventAckMessage
  | SupervisorHeartbeatAckMessage;

export class AgentDockWireProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDockWireProtocolError";
  }
}

function schemaErrorMessage(
  direction: "supervisor-to-control" | "control-to-supervisor",
  issue: { instancePath: string; message: string } | undefined,
): string {
  const location = issue?.instancePath.length ? issue.instancePath : "/";
  return `Invalid ${direction} message at ${location}: ${issue?.message ?? "schema validation failed"}`;
}

function assertUniqueSessionIds(
  values: ReadonlyArray<{ sessionId: string }>,
  description: string,
): void {
  const sessionIds = new Set<string>();
  for (const value of values) {
    if (sessionIds.has(value.sessionId)) {
      throw new AgentDockWireProtocolError(
        `${description} contains duplicate sessionId ${value.sessionId}`,
      );
    }
    sessionIds.add(value.sessionId);
  }
}

export function parseSupervisorToControlMessage(value: unknown): SupervisorToControlMessage {
  if (!Value.Check(SupervisorToControlMessageSchema, value)) {
    const issue = [...Value.Errors(SupervisorToControlMessageSchema, value)][0];
    throw new AgentDockWireProtocolError(schemaErrorMessage("supervisor-to-control", issue));
  }

  const message = value as SupervisorToControlMessage;
  if (message.type === "supervisor.register") {
    if (!message.payload.supportedProtocolVersions.includes(message.protocolVersion)) {
      throw new AgentDockWireProtocolError(
        "supervisor.register must include its envelope protocolVersion in supportedProtocolVersions",
      );
    }
  }

  if (message.type === "supervisor.heartbeat") {
    if (message.payload.sessions.length > message.payload.maxConcurrentSessions) {
      throw new AgentDockWireProtocolError(
        "supervisor.heartbeat sessions exceed maxConcurrentSessions",
      );
    }
    assertUniqueSessionIds(message.payload.sessions, "supervisor.heartbeat sessions");
    for (const session of message.payload.sessions) {
      if (session.lastAcknowledgedSeq > session.lastProducedSeq) {
        throw new AgentDockWireProtocolError(
          `supervisor.heartbeat session ${session.sessionId} acknowledges beyond its produced sequence`,
        );
      }
    }
  }

  return message;
}

export function parseControlToSupervisorMessage(value: unknown): ControlToSupervisorMessage {
  if (!Value.Check(ControlToSupervisorMessageSchema, value)) {
    const issue = [...Value.Errors(ControlToSupervisorMessageSchema, value)][0];
    throw new AgentDockWireProtocolError(schemaErrorMessage("control-to-supervisor", issue));
  }

  const message = value as ControlToSupervisorMessage;
  if (
    message.type === "supervisor.registered" &&
    message.payload.heartbeatTimeoutMs <= message.payload.heartbeatIntervalMs
  ) {
    throw new AgentDockWireProtocolError(
      "supervisor.registered heartbeatTimeoutMs must be greater than heartbeatIntervalMs",
    );
  }

  if (message.type === "supervisor.heartbeat.ack") {
    assertUniqueSessionIds(message.payload.leaseRenewals, "supervisor.heartbeat.ack leaseRenewals");
  }

  return message;
}
