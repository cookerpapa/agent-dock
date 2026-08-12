import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { WorkspacePatchSchema } from "./event-envelope.ts";
import { GitHubRepositorySourceSchema } from "./control-plane-api.ts";
import { AgentWorkspaceSeedSchema, SandboxCheckpointBlobSchema } from "./agent-runtime.ts";
import { OpaqueIdSchema, PositiveSafeIntegerSchema, UuidSchema } from "./protocol-primitives.ts";
import {
  EnvironmentRuntimeSnapshotSchema,
  EnvironmentRecipeCommandResultSchema,
  EnvironmentToolchainReportSchema,
  EnvironmentValidationReportSchema,
} from "./environment.ts";

export const MAX_TOOL_COMMAND_BYTES = 64 * 1_024;
export const MAX_TOOL_FILE_BYTES = 512 * 1_024;
export const MAX_TOOL_MUTATION_FILE_BYTES = 2 * 1_024 * 1_024;
export const MAX_TOOL_RANGE_FILE_BYTES = 64 * 1_024 * 1_024;
export const MAX_TOOL_READ_RANGE_BYTES = 50 * 1_024;
export const MAX_TOOL_READ_RANGE_LINES = 2_000;
export const MAX_TOOL_OUTPUT_BYTES = 1 * 1_024 * 1_024;

const ToolSandboxEnvelope = {
  toolBrokerProtocolVersion: Type.Literal(1),
};

const WorkerEnvelope = {
  toolWorkerProtocolVersion: Type.Literal(1),
};

const SafeCodeSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
});

const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

const Base64Schema = Type.String({
  maxLength: Math.ceil(MAX_TOOL_OUTPUT_BYTES / 3) * 4 + 4,
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

const MutationFileBase64Schema = Type.String({
  maxLength: Math.ceil(MAX_TOOL_MUTATION_FILE_BYTES / 3) * 4 + 4,
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

const ToolOutputChunkSchema = Type.Object(
  {
    seq: PositiveSafeIntegerSchema,
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
    data: Base64Schema,
  },
  { additionalProperties: false },
);

export const DependencyProxyBootstrapSchema = Type.Object(
  {
    host: Type.String({ minLength: 7, maxLength: 15, pattern: "^[0-9.]+$" }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    capability: Type.String({
      minLength: 128,
      maxLength: 16_384,
      pattern: "^adpc1_[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{86}$",
    }),
    publicKeyFingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

export const ToolWebProxyBootstrapSchema = Type.Object(
  {
    host: Type.String({ minLength: 7, maxLength: 15, pattern: "^[0-9.]+$" }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  },
  { additionalProperties: false },
);

export const ToolWorkerEnvironmentStageSchema = Type.Union([
  Type.Object({ type: Type.Literal("dependency_setup") }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("offline_restore"),
      setupCommands: Type.Array(EnvironmentRecipeCommandResultSchema, { maxItems: 10 }),
    },
    { additionalProperties: false },
  ),
]);

const ToolWorkerWorkspaceAttachSchema = Type.Object(
  {
    recipeCommands: Type.Array(EnvironmentRecipeCommandResultSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);

export const ToolSandboxAssignmentSchema = Type.Object(
  {
    tenantId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    supervisorId: OpaqueIdSchema,
    bootId: UuidSchema,
    sandboxId: UuidSchema,
    commandId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    turnId: OpaqueIdSchema,
    attemptId: UuidSchema,
    leaseId: UuidSchema,
    fencingToken: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const ToolSandboxCreateRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.create"),
    requestId: UuidSchema,
    assignment: ToolSandboxAssignmentSchema,
    turnContextSha256: Sha256Schema,
    attemptContextSha256: Sha256Schema,
    environment: EnvironmentRuntimeSnapshotSchema,
    workspaceSeed: AgentWorkspaceSeedSchema,
    workspaceRestore: Type.Optional(SandboxCheckpointBlobSchema),
    workspaceRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  },
  { additionalProperties: false },
);

export const ToolSandboxCreateResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.reserved"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
    capability: Type.String({ pattern: "^adts_[A-Za-z0-9_-]{43}$" }),
    workspaceRoot: Type.Literal("/workspace"),
    continuity: Type.Union([Type.Literal("cold_restore"), Type.Literal("warm_reuse")]),
  },
  { additionalProperties: false },
);

export const ToolSandboxCreateRedirectResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.owner_redirect"),
    requestId: UuidSchema,
    ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);

export const ToolSandboxCaptureRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.capture"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    assignment: ToolSandboxAssignmentSchema,
  },
  { additionalProperties: false },
);

export const ToolSandboxCaptureResponseSchema = Type.Union([
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.captured"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      workspace: SandboxCheckpointBlobSchema,
      workspacePatch: Type.Optional(WorkspacePatchSchema),
      environment: EnvironmentValidationReportSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.unused"),
      requestId: UuidSchema,
      activationId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ToolSandboxReleaseRequestSchema = Type.Union([
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.release"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      assignment: ToolSandboxAssignmentSchema,
      disposition: Type.Literal("keep_warm"),
      workspaceRevision: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.release"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      assignment: ToolSandboxAssignmentSchema,
      disposition: Type.Literal("keep_persistent"),
      workspaceRevision: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.release"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      assignment: ToolSandboxAssignmentSchema,
      disposition: Type.Literal("destroy"),
    },
    { additionalProperties: false },
  ),
]);

export const ToolSandboxReleaseResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.released"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    retained: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ToolSandboxStopRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.stop"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    assignment: ToolSandboxAssignmentSchema,
  },
  { additionalProperties: false },
);

export const ToolSandboxStopResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.stopped"),
    requestId: UuidSchema,
    activationId: UuidSchema,
  },
  { additionalProperties: false },
);

export const ToolBrokerGitHubImportRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.github_import"),
    requestId: UuidSchema,
    source: GitHubRepositorySourceSchema,
  },
  { additionalProperties: false },
);

export const ToolBrokerGitHubImportResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.github_imported"),
    requestId: UuidSchema,
    snapshot: SandboxCheckpointBlobSchema,
  },
  { additionalProperties: false },
);

export const ToolBrokerMaterializeFileRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.materialize_file"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    snapshot: SandboxCheckpointBlobSchema,
    path: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export const ToolBrokerMaterializeFileResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.file_materialized"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    path: Type.String({ minLength: 1, maxLength: 512 }),
    content: Base64Schema,
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    executable: Type.Boolean(),
    sizeBytes: Type.Integer({ minimum: 0, maximum: MAX_TOOL_FILE_BYTES }),
  },
  { additionalProperties: false },
);

export const ToolBrokerRequestSchema = Type.Union([
  ToolSandboxCreateRequestSchema,
  ToolSandboxCaptureRequestSchema,
  ToolSandboxReleaseRequestSchema,
  ToolSandboxStopRequestSchema,
  ToolBrokerGitHubImportRequestSchema,
]);

export const ToolBrokerResponseSchema = Type.Union([
  ToolSandboxCreateResponseSchema,
  ToolSandboxCreateRedirectResponseSchema,
  ToolSandboxCaptureResponseSchema,
  ToolSandboxReleaseResponseSchema,
  ToolSandboxStopResponseSchema,
  ToolBrokerGitHubImportResponseSchema,
]);

const OperationEnvelope = {
  ...ToolSandboxEnvelope,
  type: Type.Literal("tool_sandbox.operation"),
  activationId: UuidSchema,
  operationId: UuidSchema,
  turnContextSha256: Sha256Schema,
  attemptContextSha256: Sha256Schema,
  stepContextSequence: PositiveSafeIntegerSchema,
  stepContextSha256: Sha256Schema,
};

const ToolPathSchema = Type.String({ minLength: 1, maxLength: 4_096 });

export const ToolSandboxOperationRequestSchema = Type.Union([
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("bash.exec"),
      command: Type.String({ minLength: 1, maxLength: MAX_TOOL_COMMAND_BYTES }),
      cwd: ToolPathSchema,
      timeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.read"),
      path: ToolPathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.read_range"),
      path: ToolPathSchema,
      offsetLine: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
      limitLines: Type.Integer({ minimum: 1, maximum: MAX_TOOL_READ_RANGE_LINES }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.write"),
      path: ToolPathSchema,
      content: Type.String({ maxLength: MAX_TOOL_MUTATION_FILE_BYTES }),
      expectedSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.mkdir"),
      path: ToolPathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.access"),
      path: ToolPathSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ToolSandboxOperationResponseSchema = Type.Union([
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("bash.exec"),
      exitCode: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
      outputChunks: Type.Array(ToolOutputChunkSchema, { maxItems: 16_384 }),
      outputSha256: Sha256Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("file.read"),
      content: MutationFileBase64Schema,
      sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("file.read_range"),
      content: Base64Schema,
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Integer({ minimum: 0 }),
      nextOffsetLine: Type.Optional(Type.Integer({ minimum: 1 })),
      firstLineBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("file.write"),
      sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Union([Type.Literal("file.mkdir"), Type.Literal("file.access")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_failed"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      code: SafeCodeSchema,
      message: Type.String({ minLength: 1, maxLength: 512 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export const ToolWorkerInputSchema = Type.Union([
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.initialize"),
      activationId: UuidSchema,
      environment: EnvironmentRuntimeSnapshotSchema,
      workspaceSeed: AgentWorkspaceSeedSchema,
      workspaceRestore: Type.Optional(SandboxCheckpointBlobSchema),
      dependencyProxy: Type.Optional(DependencyProxyBootstrapSchema),
      webProxy: Type.Optional(ToolWebProxyBootstrapSchema),
      environmentStage: Type.Optional(ToolWorkerEnvironmentStageSchema),
      workspaceAttach: Type.Optional(ToolWorkerWorkspaceAttachSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.operation"),
      request: ToolSandboxOperationRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.cancel"),
      activationId: UuidSchema,
      operationId: UuidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.capture"),
      activationId: UuidSchema,
      requestId: UuidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.shutdown"),
      activationId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ToolWorkerOutputSchema = Type.Union([
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.ready"),
      activationId: UuidSchema,
      environment: EnvironmentToolchainReportSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.operation_result"),
      response: ToolSandboxOperationResponseSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.captured"),
      activationId: UuidSchema,
      requestId: UuidSchema,
      workspace: SandboxCheckpointBlobSchema,
      workspacePatch: Type.Optional(WorkspacePatchSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.failed"),
      activationId: Type.Optional(UuidSchema),
      requestId: Type.Optional(UuidSchema),
      operationId: Type.Optional(UuidSchema),
      code: SafeCodeSchema,
      message: Type.String({ minLength: 1, maxLength: 512 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export type ToolSandboxAssignment = Static<typeof ToolSandboxAssignmentSchema>;
export type ToolSandboxCreateRequest = Static<typeof ToolSandboxCreateRequestSchema>;
export type ToolSandboxCreateResponse = Static<typeof ToolSandboxCreateResponseSchema>;
export type ToolSandboxCreateRedirectResponse = Static<
  typeof ToolSandboxCreateRedirectResponseSchema
>;
export type ToolSandboxCaptureRequest = Static<typeof ToolSandboxCaptureRequestSchema>;
export type ToolSandboxCaptureResponse = Static<typeof ToolSandboxCaptureResponseSchema>;
export type ToolSandboxReleaseRequest = Static<typeof ToolSandboxReleaseRequestSchema>;
export type ToolSandboxReleaseResponse = Static<typeof ToolSandboxReleaseResponseSchema>;
export type ToolSandboxStopRequest = Static<typeof ToolSandboxStopRequestSchema>;
export type ToolSandboxStopResponse = Static<typeof ToolSandboxStopResponseSchema>;
export type ToolBrokerGitHubImportRequest = Static<typeof ToolBrokerGitHubImportRequestSchema>;
export type ToolBrokerGitHubImportResponse = Static<typeof ToolBrokerGitHubImportResponseSchema>;
export type ToolBrokerMaterializeFileRequest = Static<
  typeof ToolBrokerMaterializeFileRequestSchema
>;
export type ToolBrokerMaterializeFileResponse = Static<
  typeof ToolBrokerMaterializeFileResponseSchema
>;
export type ToolBrokerRequest = Static<typeof ToolBrokerRequestSchema>;
export type ToolBrokerResponse = Static<typeof ToolBrokerResponseSchema>;
export type ToolSandboxOperationRequest = Static<typeof ToolSandboxOperationRequestSchema>;
export type ToolSandboxOperationResponse = Static<typeof ToolSandboxOperationResponseSchema>;
export type ToolWorkerInput = Static<typeof ToolWorkerInputSchema>;
export type ToolWorkerOutput = Static<typeof ToolWorkerOutputSchema>;
export type DependencyProxyBootstrap = Static<typeof DependencyProxyBootstrapSchema>;
export type ToolWebProxyBootstrap = Static<typeof ToolWebProxyBootstrapSchema>;
export type ToolWorkerEnvironmentStage = Static<typeof ToolWorkerEnvironmentStageSchema>;

export class ToolSandboxProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolSandboxProtocolError";
  }
}

function parse<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new ToolSandboxProtocolError(
      `${label} failed validation at ${location}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return value as T;
}

export function parseToolBrokerRequest(value: unknown): ToolBrokerRequest {
  return parse(ToolBrokerRequestSchema, value, "Tool Broker request");
}

export function parseToolBrokerResponse(value: unknown): ToolBrokerResponse {
  return parse(ToolBrokerResponseSchema, value, "Tool Broker response");
}

export function parseToolBrokerMaterializeFileRequest(
  value: unknown,
): ToolBrokerMaterializeFileRequest {
  return parse(
    ToolBrokerMaterializeFileRequestSchema,
    value,
    "Tool Broker materialize file request",
  );
}

export function parseToolBrokerMaterializeFileResponse(
  value: unknown,
): ToolBrokerMaterializeFileResponse {
  return parse(
    ToolBrokerMaterializeFileResponseSchema,
    value,
    "Tool Broker materialize file response",
  );
}

export function parseToolSandboxOperationRequest(value: unknown): ToolSandboxOperationRequest {
  return parse(ToolSandboxOperationRequestSchema, value, "Tool Sandbox operation request");
}

export function parseToolSandboxOperationResponse(value: unknown): ToolSandboxOperationResponse {
  return parse(ToolSandboxOperationResponseSchema, value, "Tool Sandbox operation response");
}

export function parseToolWorkerInput(value: unknown): ToolWorkerInput {
  return parse(ToolWorkerInputSchema, value, "Tool worker input");
}

export function parseToolWorkerOutput(value: unknown): ToolWorkerOutput {
  return parse(ToolWorkerOutputSchema, value, "Tool worker output");
}
