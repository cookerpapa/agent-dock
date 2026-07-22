import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { GitHubRepositorySourceSchema } from "./control-plane-api.ts";
import { SandboxCheckpointBlobSchema } from "./agent-runtime.ts";
import { UuidSchema } from "./protocol-primitives.ts";
import { DependencyProxyBootstrapSchema } from "./tool-sandbox.ts";

const WorkspaceImportEnvelopeProperties = {
  workspaceImportProtocolVersion: Type.Literal(1),
  importId: UuidSchema,
};

export const GitHubWorkspaceImportRequestSchema = Type.Object(
  {
    ...WorkspaceImportEnvelopeProperties,
    type: Type.Literal("workspace.import"),
    source: GitHubRepositorySourceSchema,
    egressProxy: DependencyProxyBootstrapSchema,
  },
  { additionalProperties: false },
);

export const GitHubWorkspaceImportResultSchema = Type.Object(
  {
    ...WorkspaceImportEnvelopeProperties,
    type: Type.Literal("workspace.import.result"),
    snapshot: SandboxCheckpointBlobSchema,
  },
  { additionalProperties: false },
);

export const GitHubWorkspaceImportFailureSchema = Type.Object(
  {
    ...WorkspaceImportEnvelopeProperties,
    type: Type.Literal("workspace.import.failed"),
    code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
    message: Type.String({ minLength: 1, maxLength: 1_024 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const GitHubWorkspaceImportOutputSchema = Type.Union([
  GitHubWorkspaceImportResultSchema,
  GitHubWorkspaceImportFailureSchema,
]);

export type GitHubWorkspaceImportRequest = Static<typeof GitHubWorkspaceImportRequestSchema>;
export type GitHubWorkspaceImportResult = Static<typeof GitHubWorkspaceImportResultSchema>;
export type GitHubWorkspaceImportFailure = Static<typeof GitHubWorkspaceImportFailureSchema>;
export type GitHubWorkspaceImportOutput = Static<typeof GitHubWorkspaceImportOutputSchema>;

export class GitHubWorkspaceImportProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubWorkspaceImportProtocolError";
  }
}

function parseWithSchema<T>(schema: object, value: unknown, description: string): T {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new GitHubWorkspaceImportProtocolError(
      `Invalid ${description} at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as T;
}

export function parseGitHubWorkspaceImportRequest(value: unknown): GitHubWorkspaceImportRequest {
  return parseWithSchema(
    GitHubWorkspaceImportRequestSchema,
    value,
    "GitHub workspace import request",
  );
}

export function parseGitHubWorkspaceImportOutput(value: unknown): GitHubWorkspaceImportOutput {
  return parseWithSchema(
    GitHubWorkspaceImportOutputSchema,
    value,
    "GitHub workspace import output",
  );
}
