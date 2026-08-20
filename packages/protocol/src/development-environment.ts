import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { AgentWorkspaceSeedSchema } from "./agent-runtime.ts";
import { EnvironmentRuntimeSnapshotSchema } from "./environment.ts";
import { UuidSchema } from "./protocol-primitives.ts";

export const TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH =
  "/internal/v1/development-environments" as const;
export const TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH =
  "/internal/v1/development-environment-terminal" as const;

export const DevelopmentEnvironmentBrokerStateSchema = Type.Union([
  Type.Literal("provisioning"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("releasing"),
  Type.Literal("released"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);

export const DevelopmentEnvironmentProvisionRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment.provision"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    environment: EnvironmentRuntimeSnapshotSchema,
    workspaceSeed: AgentWorkspaceSeedSchema,
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentLifecycleRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment.lifecycle"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("release")]),
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentBrokerRequestSchema = Type.Union([
  DevelopmentEnvironmentProvisionRequestSchema,
  DevelopmentEnvironmentLifecycleRequestSchema,
]);

export const DevelopmentEnvironmentBrokerResponseSchema = Type.Union([
  Type.Object(
    {
      developmentEnvironmentProtocolVersion: Type.Literal(1),
      type: Type.Literal("development_environment.state"),
      requestId: UuidSchema,
      environmentId: UuidSchema,
      state: DevelopmentEnvironmentBrokerStateSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      developmentEnvironmentProtocolVersion: Type.Literal(1),
      type: Type.Literal("development_environment.owner_redirect"),
      requestId: UuidSchema,
      ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
    },
    { additionalProperties: false },
  ),
]);

export const DevelopmentEnvironmentTerminalOpenRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment_terminal.open"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    rows: Type.Integer({ minimum: 2, maximum: 512 }),
    cols: Type.Integer({ minimum: 2, maximum: 512 }),
  },
  { additionalProperties: false },
);

export type DevelopmentEnvironmentProvisionRequest = Static<
  typeof DevelopmentEnvironmentProvisionRequestSchema
>;
export type DevelopmentEnvironmentLifecycleRequest = Static<
  typeof DevelopmentEnvironmentLifecycleRequestSchema
>;
export type DevelopmentEnvironmentBrokerRequest = Static<
  typeof DevelopmentEnvironmentBrokerRequestSchema
>;
export type DevelopmentEnvironmentBrokerResponse = Static<
  typeof DevelopmentEnvironmentBrokerResponseSchema
>;
export type DevelopmentEnvironmentTerminalOpenRequest = Static<
  typeof DevelopmentEnvironmentTerminalOpenRequestSchema
>;

export class DevelopmentEnvironmentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentEnvironmentProtocolError";
  }
}

function parse<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    throw new DevelopmentEnvironmentProtocolError(`${label} failed validation`);
  }
  return value as Static<Schema>;
}

export function parseDevelopmentEnvironmentBrokerRequest(
  value: unknown,
): DevelopmentEnvironmentBrokerRequest {
  return parse(DevelopmentEnvironmentBrokerRequestSchema, value, "development environment request");
}

export function parseDevelopmentEnvironmentBrokerResponse(
  value: unknown,
): DevelopmentEnvironmentBrokerResponse {
  return parse(
    DevelopmentEnvironmentBrokerResponseSchema,
    value,
    "development environment response",
  );
}

export function parseDevelopmentEnvironmentTerminalOpenRequest(
  value: unknown,
): DevelopmentEnvironmentTerminalOpenRequest {
  return parse(
    DevelopmentEnvironmentTerminalOpenRequestSchema,
    value,
    "development environment terminal request",
  );
}
