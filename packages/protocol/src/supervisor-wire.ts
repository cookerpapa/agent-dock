import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  AgentDockEventSchema,
  SessionStateSchema,
  TurnCancellationReasonSchema,
  WorkspacePatchSchema,
} from "./event-envelope.ts";
import {
  NonNegativeSafeIntegerSchema,
  OpaqueIdSchema,
  PositiveSafeIntegerSchema,
  SandboxRetentionPolicySchema,
  TraceContextSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";
import { EnvironmentRuntimeSnapshotSchema } from "./environment.ts";

export const TWO_PHASE_COMMAND_CAPABILITY = "command.two_phase.v1";
export const PI_STEER_CAPABILITY = "pi.steer.v1";

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
  runId: UuidSchema,
  turnId: OpaqueIdSchema,
  attemptId: UuidSchema,
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

const ModelThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const TurnModelSnapshotSchema = Type.Object(
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

export const TurnBudgetSnapshotSchema = Type.Object(
  {
    maximumModelRequests: Type.Integer({ minimum: 1, maximum: 1_024 }),
    maximumCostMicrousd: Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
    dailyTokenBudget: Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
    monthlyCostMicrousdBudget: Type.Integer({
      minimum: 1,
      maximum: 1_000_000_000_000_000,
    }),
    maximumToolCalls: Type.Integer({ minimum: 1, maximum: 10_000 }),
    remainingToolCalls: Type.Integer({ minimum: 0, maximum: 10_000 }),
    maximumToolOutputBytes: Type.Integer({ minimum: 1_024, maximum: 1_048_576 }),
    maximumRunDurationMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    compactionReserveTokens: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
    compactionKeepRecentTokens: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);
export type TurnBudgetSnapshot = Static<typeof TurnBudgetSnapshotSchema>;

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
        acceptingAssignments: Type.Boolean(),
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
        sandboxRetention: SandboxRetentionPolicySchema,
        model: TurnModelSnapshotSchema,
        environment: EnvironmentRuntimeSnapshotSchema,
        budgets: Type.Optional(TurnBudgetSnapshotSchema),
        traceContext: Type.Optional(TraceContextSchema),
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
        targetCommandId: UuidSchema,
        reason: TurnCancellationReasonSchema,
        gracePeriodMs: Type.Optional(NonNegativeSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SteerTurnCommandMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.turn.steer"),
    payload: Type.Object(
      {
        ...CommandIdentityProperties,
        targetCommandId: UuidSchema,
        text: Type.String({ minLength: 1, maxLength: 100_000 }),
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

const CommandDispositionPayloadSchema = Type.Object(
  {
    ...CommandAckIdentityProperties,
    acknowledgedMessageId: UuidSchema,
  },
  { additionalProperties: false },
);

export const CommandCommitMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.commit"),
    payload: CommandDispositionPayloadSchema,
  },
  { additionalProperties: false },
);

export const CommandReleaseMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.release"),
    payload: CommandDispositionPayloadSchema,
  },
  { additionalProperties: false },
);

const CommandResultIdentityProperties = {
  ...CommandAckIdentityProperties,
  commitMessageId: UuidSchema,
};

const CompletedExecuteCommandResultPayloadSchema = Type.Object(
  {
    ...CommandResultIdentityProperties,
    commandKind: Type.Literal("turn.execute"),
    status: Type.Literal("completed"),
    stopReason: Type.String({ minLength: 1, maxLength: 256 }),
    workspacePatch: Type.Optional(WorkspacePatchSchema),
  },
  { additionalProperties: false },
);

const CompletedCancellationCommandResultPayloadSchema = Type.Object(
  {
    ...CommandResultIdentityProperties,
    commandKind: Type.Literal("turn.cancel"),
    status: Type.Literal("completed"),
    reason: TurnCancellationReasonSchema,
    forced: Type.Boolean(),
  },
  { additionalProperties: false },
);

const CompletedSteerCommandResultPayloadSchema = Type.Object(
  {
    ...CommandResultIdentityProperties,
    commandKind: Type.Literal("turn.steer"),
    status: Type.Literal("completed"),
  },
  { additionalProperties: false },
);

const CancelledExecuteCommandResultPayloadSchema = Type.Object(
  {
    ...CommandResultIdentityProperties,
    commandKind: Type.Literal("turn.execute"),
    status: Type.Literal("cancelled"),
    reason: TurnCancellationReasonSchema,
    forced: Type.Boolean(),
  },
  { additionalProperties: false },
);

const FailedCommandResultPayloadSchema = Type.Object(
  {
    ...CommandResultIdentityProperties,
    commandKind: Type.Union([
      Type.Literal("turn.execute"),
      Type.Literal("turn.cancel"),
      Type.Literal("turn.steer"),
    ]),
    status: Type.Literal("failed"),
    code: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
    }),
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CommandResultMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.result"),
    payload: Type.Union([
      CompletedExecuteCommandResultPayloadSchema,
      CompletedCancellationCommandResultPayloadSchema,
      CompletedSteerCommandResultPayloadSchema,
      CancelledExecuteCommandResultPayloadSchema,
      FailedCommandResultPayloadSchema,
    ]),
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

export const EventPublishBatchMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("event.publish_batch"),
    payload: Type.Object(
      {
        ...LeaseProperties,
        commandId: Type.Optional(UuidSchema),
        events: Type.Array(AgentDockEventSchema, { minItems: 1, maxItems: 128 }),
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

export const EventRejectedMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("event.rejected"),
    payload: Type.Object(
      {
        sessionId: OpaqueIdSchema,
        ...LeaseProperties,
        rejectedSeq: PositiveSafeIntegerSchema,
        code: Type.Literal("stale_fence"),
        retryable: Type.Literal(false),
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
  CommandResultMessageSchema,
  EventPublishMessageSchema,
  EventPublishBatchMessageSchema,
  SupervisorHeartbeatMessageSchema,
]);

export const ControlToSupervisorMessageSchema = Type.Union([
  SupervisorRegisteredMessageSchema,
  ExecuteTurnCommandMessageSchema,
  CancelTurnCommandMessageSchema,
  SteerTurnCommandMessageSchema,
  ResolveApprovalCommandMessageSchema,
  CommandCommitMessageSchema,
  CommandReleaseMessageSchema,
  EventAckMessageSchema,
  EventRejectedMessageSchema,
  SupervisorHeartbeatAckMessageSchema,
]);

export type SupervisorRegisterMessage = Static<typeof SupervisorRegisterMessageSchema>;
export type SupervisorRegisteredMessage = Static<typeof SupervisorRegisteredMessageSchema>;
export type ExecuteTurnCommandMessage = Static<typeof ExecuteTurnCommandMessageSchema>;
export type CancelTurnCommandMessage = Static<typeof CancelTurnCommandMessageSchema>;
export type SteerTurnCommandMessage = Static<typeof SteerTurnCommandMessageSchema>;
export type ResolveApprovalCommandMessage = Static<typeof ResolveApprovalCommandMessageSchema>;
export type CommandAckMessage = Static<typeof CommandAckMessageSchema>;
export type CommandCommitMessage = Static<typeof CommandCommitMessageSchema>;
export type CommandReleaseMessage = Static<typeof CommandReleaseMessageSchema>;
export type CommandResultMessage = Static<typeof CommandResultMessageSchema>;
export type EventPublishMessage = Static<typeof EventPublishMessageSchema>;
export type EventPublishBatchMessage = Static<typeof EventPublishBatchMessageSchema>;
export type EventAckMessage = Static<typeof EventAckMessageSchema>;
export type EventRejectedMessage = Static<typeof EventRejectedMessageSchema>;
export type SupervisorHeartbeatMessage = Static<typeof SupervisorHeartbeatMessageSchema>;
export type SupervisorHeartbeatAckMessage = Static<typeof SupervisorHeartbeatAckMessageSchema>;

export type SupervisorToControlMessage =
  | SupervisorRegisterMessage
  | CommandAckMessage
  | CommandResultMessage
  | EventPublishMessage
  | EventPublishBatchMessage
  | SupervisorHeartbeatMessage;

export type ControlToSupervisorMessage =
  | SupervisorRegisteredMessage
  | ExecuteTurnCommandMessage
  | CancelTurnCommandMessage
  | SteerTurnCommandMessage
  | ResolveApprovalCommandMessage
  | CommandCommitMessage
  | CommandReleaseMessage
  | EventAckMessage
  | EventRejectedMessage
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
