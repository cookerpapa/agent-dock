import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { AgentWorkspaceSeedSchema } from "./agent-runtime.ts";
import { EnvironmentRuntimeSnapshotSchema } from "./environment.ts";
import { UuidSchema } from "./protocol-primitives.ts";

export const MAX_WORKSPACE_TERMINAL_FRAME_BYTES = 64 * 1_024;

const Base64Schema = Type.String({
  maxLength: Math.ceil(MAX_WORKSPACE_TERMINAL_FRAME_BYTES / 3) * 4,
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

const TerminalSize = {
  rows: Type.Integer({ minimum: 2, maximum: 500 }),
  cols: Type.Integer({ minimum: 2, maximum: 1_000 }),
};

export const WorkspaceTerminalOpenRequestSchema = Type.Object(
  {
    workspaceTerminalProtocolVersion: Type.Literal(1),
    type: Type.Literal("workspace_terminal.open"),
    requestId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    environment: EnvironmentRuntimeSnapshotSchema,
    workspaceSeed: AgentWorkspaceSeedSchema,
    ...TerminalSize,
  },
  { additionalProperties: false },
);

export const WorkspaceTerminalClientFrameSchema = Type.Union([
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.input"),
      data: Base64Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.resize"),
      ...TerminalSize,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.close"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.ping"),
    },
    { additionalProperties: false },
  ),
]);

export const WorkspaceTerminalServerFrameSchema = Type.Union([
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.owner_redirect"),
      ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.ready"),
      terminalId: UuidSchema,
      pid: Type.Integer({ minimum: 1 }),
      workspaceRoot: Type.Literal("/workspace"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.output"),
      data: Base64Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.exit"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.error"),
      code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
      message: Type.String({ minLength: 1, maxLength: 512 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workspaceTerminalProtocolVersion: Type.Literal(1),
      type: Type.Literal("workspace_terminal.pong"),
    },
    { additionalProperties: false },
  ),
]);

export type WorkspaceTerminalOpenRequest = Static<typeof WorkspaceTerminalOpenRequestSchema>;
export type WorkspaceTerminalClientFrame = Static<typeof WorkspaceTerminalClientFrameSchema>;
export type WorkspaceTerminalServerFrame = Static<typeof WorkspaceTerminalServerFrameSchema>;

export class WorkspaceTerminalProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTerminalProtocolError";
  }
}

function parse<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new WorkspaceTerminalProtocolError(`${label} failed validation`);
  }
  return Value.Decode(schema, value) as Static<T>;
}

export function parseWorkspaceTerminalOpenRequest(value: unknown): WorkspaceTerminalOpenRequest {
  return parse(WorkspaceTerminalOpenRequestSchema, value, "Workspace terminal open request");
}

export function parseWorkspaceTerminalClientFrame(value: unknown): WorkspaceTerminalClientFrame {
  return parse(WorkspaceTerminalClientFrameSchema, value, "Workspace terminal client frame");
}

export function parseWorkspaceTerminalServerFrame(value: unknown): WorkspaceTerminalServerFrame {
  return parse(WorkspaceTerminalServerFrameSchema, value, "Workspace terminal server frame");
}
