import { describe, expect, it } from "vitest";
import {
  PiCloudWireProtocolError,
  createPiCloudEventFactory,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
} from "../src/index.ts";

const IDS = {
  message: "11111111-1111-4111-8111-111111111111",
  message2: "22222222-2222-4222-8222-222222222222",
  message3: "33333333-3333-4333-8333-333333333333",
  boot: "44444444-4444-4444-8444-444444444444",
  connection: "55555555-5555-4555-8555-555555555555",
  lease: "66666666-6666-4666-8666-666666666666",
  command: "77777777-7777-4777-8777-777777777777",
  targetCommand: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  run: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  attempt: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  approval: "88888888-8888-4888-8888-888888888888",
  event: "99999999-9999-4999-8999-999999999999",
  commit: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const SENT_AT = "2026-07-18T08:00:00.000Z";

function envelope(messageId = IDS.message) {
  return {
    protocolVersion: 1,
    messageId,
    sentAt: SENT_AT,
  } as const;
}

function commandIdentity() {
  return {
    commandId: IDS.command,
    idempotencyKey: "request-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    runId: IDS.run,
    turnId: "turn-1",
    attemptId: IDS.attempt,
    agentId: "root",
    leaseId: IDS.lease,
    fencingToken: 7,
  } as const;
}

function modelSnapshot() {
  return {
    profileId: "profile-1",
    provider: "pi-cloud-fake",
    modelId: "pi-cloud-fake",
    thinkingLevel: "off",
    credentialBindingId: "credential-binding-1",
    credentialBindingVersion: 3,
  } as const;
}

function environmentSnapshot() {
  return {
    environmentVersionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    versionNumber: 1,
    profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
    profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
    imageRevision: "sha-0123456789abcdef",
    specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
    recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
    recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  } as const;
}

function commandResultIdentity() {
  return {
    commandId: IDS.command,
    sessionId: "session-1",
    turnId: "turn-1",
    leaseId: IDS.lease,
    fencingToken: 7,
    commitMessageId: IDS.commit,
  } as const;
}

function registration() {
  return {
    ...envelope(),
    type: "supervisor.register",
    payload: {
      supervisorId: "supervisor-1",
      bootId: IDS.boot,
      sandboxId: "sandbox-1",
      supervisorVersion: "0.1.0",
      pi: {
        packageName: "@earendil-works/pi-coding-agent",
        version: "0.84.1",
      },
      supportedProtocolVersions: [1],
      capabilities: ["pi.sdk", "event.replay", "extension_ui.confirm"],
      acceptingAssignments: true,
      maxConcurrentSessions: 4,
    },
  } as const;
}

function heartbeat() {
  return {
    ...envelope(IDS.message2),
    type: "supervisor.heartbeat",
    payload: {
      supervisorId: "supervisor-1",
      bootId: IDS.boot,
      connectionId: IDS.connection,
      acceptingAssignments: true,
      maxConcurrentSessions: 4,
      sessions: [
        {
          sessionId: "session-1",
          turnId: "turn-1",
          state: "running",
          leaseId: IDS.lease,
          fencingToken: 7,
          lastProducedSeq: 12,
          lastAcknowledgedSeq: 10,
        },
      ],
    },
  } as const;
}

describe("supervisor/control-plane wire protocol", () => {
  it("parses registration only in the supervisor-to-control direction", () => {
    const message = registration();

    expect(parseSupervisorToControlMessage(message)).toEqual(message);
    expect(() => parseControlToSupervisorMessage(message)).toThrow(PiCloudWireProtocolError);
  });

  it("requires registration to advertise the envelope protocol version", () => {
    const message = registration();
    expect(() =>
      parseSupervisorToControlMessage({
        ...message,
        payload: { ...message.payload, supportedProtocolVersions: [2] },
      }),
    ).toThrow("must include its envelope protocolVersion");
  });

  it("requires registration to declare its initial assignment drain state", () => {
    const message = registration();
    const { acceptingAssignments: _acceptingAssignments, ...payload } = message.payload;
    expect(() =>
      parseSupervisorToControlMessage({
        ...message,
        payload,
      }),
    ).toThrow(PiCloudWireProtocolError);
  });

  it("parses each control-plane command and rejects unreviewed fields", () => {
    const execute = {
      ...envelope(),
      type: "command.turn.execute",
      payload: {
        ...commandIdentity(),
        nextEventSeq: 11,
        input: { kind: "prompt", text: "Fix the failing test" },
        sandboxRetention: "ephemeral",
        model: modelSnapshot(),
        environment: environmentSnapshot(),
        traceContext: {
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        },
      },
    } as const;
    const cancel = {
      ...envelope(IDS.message2),
      type: "command.turn.cancel",
      payload: {
        ...commandIdentity(),
        targetCommandId: IDS.targetCommand,
        reason: "user_request",
        gracePeriodMs: 2_000,
      },
    } as const;
    const resolve = {
      ...envelope(IDS.message3),
      type: "command.approval.resolve",
      payload: {
        ...commandIdentity(),
        approvalId: IDS.approval,
        decision: { outcome: "approved", value: "yes" },
      },
    } as const;
    const steer = {
      ...envelope("44444444-1111-4111-8111-444444444444"),
      type: "command.turn.steer",
      payload: {
        ...commandIdentity(),
        commandId: "55555555-1111-4111-8111-555555555555",
        targetCommandId: IDS.targetCommand,
        text: "Focus on the failing integration test.",
      },
    } as const;

    expect(
      [execute, cancel, steer, resolve].map(
        (message) => parseControlToSupervisorMessage(message).type,
      ),
    ).toEqual([
      "command.turn.execute",
      "command.turn.cancel",
      "command.turn.steer",
      "command.approval.resolve",
    ]);
    const parsedExecute = parseControlToSupervisorMessage(execute);
    if (parsedExecute.type !== "command.turn.execute") throw new Error("Expected execute command");
    expect(parsedExecute.payload.traceContext?.traceparent).toContain(
      "11111111111111111111111111111111",
    );
    expect(() =>
      parseControlToSupervisorMessage({
        ...execute,
        payload: {
          ...execute.payload,
          traceContext: {
            traceparent: "00-00000000000000000000000000000000-2222222222222222-01",
          },
        },
      }),
    ).toThrow(PiCloudWireProtocolError);
    expect(() =>
      parseControlToSupervisorMessage({
        ...execute,
        payload: { ...execute.payload, rawPiCommand: { type: "prompt" } },
      }),
    ).toThrow(PiCloudWireProtocolError);
    expect(() =>
      parseControlToSupervisorMessage({
        ...execute,
        payload: {
          ...execute.payload,
          model: { ...execute.payload.model, apiKey: "must-not-cross-the-wire" },
        },
      }),
    ).toThrow(PiCloudWireProtocolError);
  });

  it("wraps only validated PiCloud events and keeps publication direction explicit", () => {
    const eventFactory = createPiCloudEventFactory(
      { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
      {
        clock: () => new Date(SENT_AT),
        idGenerator: () => IDS.event,
      },
    );
    const event = eventFactory.next({
      type: "assistant.text.delta",
      payload: { text: "hello" },
    });
    const publish = {
      ...envelope(),
      type: "event.publish",
      payload: {
        leaseId: IDS.lease,
        fencingToken: 7,
        commandId: IDS.command,
        event,
      },
    } as const;

    expect(parseSupervisorToControlMessage(publish)).toEqual(publish);
    expect(() => parseControlToSupervisorMessage(publish)).toThrow(PiCloudWireProtocolError);
    expect(() =>
      parseSupervisorToControlMessage({
        ...publish,
        payload: {
          ...publish.payload,
          event: { ...event, rawPiEvent: { type: "message_update" } },
        },
      }),
    ).toThrow(PiCloudWireProtocolError);
  });

  it("returns a closed permanent rejection without pretending the event was acknowledged", () => {
    const rejected = {
      ...envelope(),
      type: "event.rejected",
      payload: {
        sessionId: "session-1",
        leaseId: IDS.lease,
        fencingToken: 7,
        rejectedSeq: 11,
        code: "stale_fence",
        retryable: false,
      },
    } as const;

    expect(parseControlToSupervisorMessage(rejected)).toEqual(rejected);
    expect(() => parseSupervisorToControlMessage(rejected)).toThrow(PiCloudWireProtocolError);
    expect(() =>
      parseControlToSupervisorMessage({
        ...rejected,
        payload: { ...rejected.payload, retryable: true },
      }),
    ).toThrow(PiCloudWireProtocolError);
  });

  it("validates command acknowledgements in the return direction", () => {
    const accepted = {
      ...envelope(),
      type: "command.ack",
      payload: {
        commandId: IDS.command,
        sessionId: "session-1",
        turnId: "turn-1",
        leaseId: IDS.lease,
        fencingToken: 7,
        status: "accepted",
      },
    } as const;

    expect(parseSupervisorToControlMessage(accepted)).toEqual(accepted);
    expect(() => parseControlToSupervisorMessage(accepted)).toThrow(PiCloudWireProtocolError);
  });

  it("requires an exact ACK reference before commit and correlates command results", () => {
    const commit = {
      ...envelope(IDS.commit),
      type: "command.commit",
      payload: {
        commandId: IDS.command,
        sessionId: "session-1",
        turnId: "turn-1",
        leaseId: IDS.lease,
        fencingToken: 7,
        acknowledgedMessageId: IDS.message,
      },
    } as const;
    const release = {
      ...commit,
      type: "command.release",
    } as const;
    const completed = {
      ...envelope(IDS.message2),
      type: "command.result",
      payload: {
        ...commandResultIdentity(),
        commandKind: "turn.execute",
        status: "completed",
        stopReason: "stop",
        workspacePatch: {
          format: "unified_diff",
          patch: "diff --git a/example.ts b/example.ts\n",
          truncated: false,
        },
      },
    } as const;
    const cancelled = {
      ...completed,
      payload: {
        ...commandResultIdentity(),
        commandKind: "turn.execute",
        status: "cancelled",
        reason: "user_request",
        forced: false,
      },
    } as const;
    const failed = {
      ...completed,
      payload: {
        ...commandResultIdentity(),
        commandKind: "turn.cancel",
        status: "failed",
        code: "pi_process_exit",
        message: "Pi process exited",
        retryable: true,
      },
    } as const;

    expect(parseControlToSupervisorMessage(commit)).toEqual(commit);
    expect(parseControlToSupervisorMessage(release)).toEqual(release);
    expect(
      [completed, cancelled, failed].map(
        (message) => parseSupervisorToControlMessage(message).type,
      ),
    ).toEqual(["command.result", "command.result", "command.result"]);
    expect(() => parseSupervisorToControlMessage(commit)).toThrow(PiCloudWireProtocolError);
    expect(() => parseControlToSupervisorMessage(completed)).toThrow(PiCloudWireProtocolError);
    expect(() =>
      parseSupervisorToControlMessage({
        ...completed,
        payload: { ...completed.payload, apiKey: "must-not-cross-the-wire" },
      }),
    ).toThrow(PiCloudWireProtocolError);
  });

  it("checks heartbeat capacity, uniqueness, and sequence observations", () => {
    const message = heartbeat();
    expect(parseSupervisorToControlMessage(message)).toEqual(message);

    expect(() =>
      parseSupervisorToControlMessage({
        ...message,
        payload: {
          ...message.payload,
          sessions: [
            ...message.payload.sessions,
            { ...message.payload.sessions[0], turnId: "turn-2" },
          ],
        },
      }),
    ).toThrow("duplicate sessionId");

    expect(() =>
      parseSupervisorToControlMessage({
        ...message,
        payload: {
          ...message.payload,
          sessions: [{ ...message.payload.sessions[0], lastAcknowledgedSeq: 13 }],
        },
      }),
    ).toThrow("acknowledges beyond its produced sequence");

    expect(() =>
      parseSupervisorToControlMessage({
        ...message,
        payload: { ...message.payload, maxConcurrentSessions: 0 },
      }),
    ).toThrow(PiCloudWireProtocolError);
  });

  it("validates registration and heartbeat acknowledgements from the control plane", () => {
    const registered = {
      ...envelope(),
      type: "supervisor.registered",
      payload: {
        supervisorId: "supervisor-1",
        bootId: IDS.boot,
        connectionId: IDS.connection,
        selectedProtocolVersion: 1,
        heartbeatIntervalMs: 5_000,
        heartbeatTimeoutMs: 15_000,
        serverTime: SENT_AT,
      },
    } as const;
    const heartbeatAck = {
      ...envelope(IDS.message2),
      type: "supervisor.heartbeat.ack",
      payload: {
        acknowledgedMessageId: IDS.message,
        connectionId: IDS.connection,
        leaseRenewals: [
          {
            sessionId: "session-1",
            leaseId: IDS.lease,
            fencingToken: 7,
            validUntil: "2026-07-18T08:01:00.000Z",
          },
        ],
      },
    } as const;

    expect(parseControlToSupervisorMessage(registered)).toEqual(registered);
    expect(parseControlToSupervisorMessage(heartbeatAck)).toEqual(heartbeatAck);
    expect(() =>
      parseControlToSupervisorMessage({
        ...registered,
        payload: { ...registered.payload, heartbeatTimeoutMs: 5_000 },
      }),
    ).toThrow("must be greater than heartbeatIntervalMs");
    expect(() =>
      parseControlToSupervisorMessage({
        ...heartbeatAck,
        payload: {
          ...heartbeatAck.payload,
          leaseRenewals: [
            heartbeatAck.payload.leaseRenewals[0],
            heartbeatAck.payload.leaseRenewals[0],
          ],
        },
      }),
    ).toThrow("duplicate sessionId");
  });

  it("accepts a cumulative event ACK only in the control-to-supervisor direction", () => {
    const ack = {
      ...envelope(),
      type: "event.ack",
      payload: {
        sessionId: "session-1",
        leaseId: IDS.lease,
        fencingToken: 7,
        acknowledgedThroughSeq: 12,
      },
    } as const;

    expect(parseControlToSupervisorMessage(ack)).toEqual(ack);
    expect(() => parseSupervisorToControlMessage(ack)).toThrow(PiCloudWireProtocolError);
  });
});
