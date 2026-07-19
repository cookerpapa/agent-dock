import { describe, expect, it } from "vitest";
import {
  DockerSandboxWorkerProtocolError,
  parseDockerSandboxWorkerInput,
  parseDockerSandboxWorkerOutput,
} from "../src/index.ts";

const executeCommand = {
  protocolVersion: 1,
  messageId: "10000000-0000-4000-8000-000000000001",
  sentAt: "2026-07-19T00:00:00.000Z",
  type: "command.turn.execute",
  payload: {
    commandId: "20000000-0000-4000-8000-000000000001",
    idempotencyKey: "docker-run-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    agentId: "root",
    leaseId: "30000000-0000-4000-8000-000000000001",
    fencingToken: 1,
    nextEventSeq: 1,
    input: { kind: "prompt", text: "Repair the Java test." },
    model: {
      profileId: "profile-1",
      provider: "agent-dock-fake",
      modelId: "agent-dock-fake",
      thinkingLevel: "off",
      credentialBindingId: "credential-1",
      credentialBindingVersion: 1,
    },
  },
} as const;

describe("Docker sandbox worker protocol", () => {
  it("accepts a closed run request and cancellation", () => {
    expect(
      parseDockerSandboxWorkerInput({
        sandboxProtocolVersion: 1,
        type: "sandbox.run",
        command: executeCommand,
        runtime: { kind: "embedded_fake", scenario: "java_repair" },
        workspaceSeed: { kind: "sample_java" },
        checkpoint: { mode: "disabled" },
      }),
    ).toMatchObject({ type: "sandbox.run" });
    expect(
      parseDockerSandboxWorkerInput({
        sandboxProtocolVersion: 1,
        type: "sandbox.run",
        command: {
          ...executeCommand,
          payload: {
            ...executeCommand.payload,
            model: {
              ...executeCommand.payload.model,
              provider: "deepseek",
              modelId: "deepseek-v4-flash",
              credentialBindingVersion: 2,
            },
          },
        },
        runtime: {
          kind: "openai_compatible_gateway",
          provider: "deepseek",
          modelId: "deepseek-v4-flash",
          baseUrl: "http://supervisor-host:4200/v1",
          capability: `admg_${"a".repeat(43)}`,
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 8192,
          requestTimeoutMs: 150000,
          turnTimeoutMs: 600000,
        },
        workspaceSeed: { kind: "sample_java" },
        checkpoint: { mode: "disabled" },
      }),
    ).toMatchObject({ runtime: { kind: "openai_compatible_gateway" } });
    expect(
      parseDockerSandboxWorkerInput({
        sandboxProtocolVersion: 1,
        type: "sandbox.cancel",
        reason: "user_request",
        gracePeriodMs: 250,
      }),
    ).toMatchObject({ type: "sandbox.cancel" });
  });

  it("accepts worker lifecycle output and rejects extra fields", () => {
    expect(
      parseDockerSandboxWorkerOutput({
        sandboxProtocolVersion: 1,
        type: "sandbox.ready",
        piVersion: "0.80.10",
      }),
    ).toMatchObject({ type: "sandbox.ready" });
    expect(() =>
      parseDockerSandboxWorkerInput({
        sandboxProtocolVersion: 1,
        type: "sandbox.run",
        command: executeCommand,
        runtime: { kind: "embedded_fake", scenario: "java_repair" },
        workspaceSeed: { kind: "sample_java" },
        checkpoint: { mode: "disabled" },
        providerToken: "must-not-cross",
      }),
    ).toThrow(DockerSandboxWorkerProtocolError);
  });

  it("accepts a closed settled-checkpoint publish and acknowledgement", () => {
    const blob = {
      encoding: "base64",
      sha256: "a".repeat(64),
      sizeBytes: 3,
      data: "YWJj",
    } as const;
    expect(
      parseDockerSandboxWorkerOutput({
        sandboxProtocolVersion: 1,
        type: "sandbox.checkpoint.publish",
        commandId: executeCommand.payload.commandId,
        sessionId: executeCommand.payload.sessionId,
        turnId: executeCommand.payload.turnId,
        leaseId: executeCommand.payload.leaseId,
        fencingToken: executeCommand.payload.fencingToken,
        baseRevision: null,
        checkpoint: {
          format: "agent-dock.settled-checkpoint.v1",
          piSession: blob,
          workspace: blob,
        },
      }),
    ).toMatchObject({ type: "sandbox.checkpoint.publish", baseRevision: null });
    expect(
      parseDockerSandboxWorkerInput({
        sandboxProtocolVersion: 1,
        type: "sandbox.checkpoint.ack",
        commandId: executeCommand.payload.commandId,
        sessionId: executeCommand.payload.sessionId,
        turnId: executeCommand.payload.turnId,
        leaseId: executeCommand.payload.leaseId,
        fencingToken: executeCommand.payload.fencingToken,
        revision: "b".repeat(64),
      }),
    ).toMatchObject({ type: "sandbox.checkpoint.ack" });
  });
});
