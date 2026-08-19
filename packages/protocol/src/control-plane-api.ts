import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  SandboxRetentionPolicySchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";
import {
  ApprovalRequestPayloadSchema,
  SessionStateSchema,
  TurnCancellationReasonSchema,
  WorkspacePatchSchema,
} from "./event-envelope.ts";
import {
  EnvironmentRuntimeSnapshotSchema,
  ProjectEnvironmentResourceSchema,
} from "./environment.ts";

export const TurnThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const IdempotencyKeySchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const TenantApiRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);

export const DeepSeekModelIdSchema = Type.Union([
  Type.Literal("deepseek-v4-flash"),
  Type.Literal("deepseek-v4-pro"),
]);

export const ReplaceModelConfigurationRequestSchema = Type.Object(
  {
    provider: Type.Literal("deepseek"),
    modelId: DeepSeekModelIdSchema,
    apiKey: Type.String({
      minLength: 16,
      maxLength: 512,
      pattern: "^[A-Za-z0-9._-]+$",
    }),
  },
  { additionalProperties: false },
);

export const ModelConfigurationResourceSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("deterministic"),
      provider: Type.Literal("pi-cloud-fake"),
      modelId: Type.Literal("pi-cloud-fake"),
      configured: Type.Literal(false),
      credentialVersion: PositiveSafeIntegerSchema,
      updatedAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("real"),
      provider: Type.Literal("deepseek"),
      modelId: DeepSeekModelIdSchema,
      configured: Type.Literal(true),
      credentialVersion: PositiveSafeIntegerSchema,
      updatedAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ReplaceCubeProxyConfigurationRequestSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    proxyUrl: Type.Optional(
      Type.String({
        minLength: 9,
        maxLength: 2_048,
        pattern: "^https?://[^\\s\\u0000-\\u001f\\u007f]+$",
      }),
    ),
  },
  { additionalProperties: false },
);

export const CubeProxyConfigurationResourceSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    configured: Type.Boolean(),
    proxyUrl: Type.Optional(Type.String({ minLength: 9, maxLength: 2_048 })),
    revision: NonNegativeSafeIntegerSchema,
    updatedAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const InternalCubeProxyConfigurationResourceSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    upstreamProxyUrl: Type.Optional(Type.String({ minLength: 9, maxLength: 2_048 })),
    revision: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const TenantIdentityResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    tenantSlug: Type.String({ minLength: 1, maxLength: 256 }),
    userId: UuidSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    role: TenantApiRoleSchema,
    platformAdministrator: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AccountUsernameSchema = Type.String({
  minLength: 3,
  maxLength: 48,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,47}$",
});

const AccountPasswordSchema = Type.String({ minLength: 10, maxLength: 128 });

export const RegisterAccountRequestSchema = Type.Object(
  {
    username: AccountUsernameSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    password: AccountPasswordSchema,
  },
  { additionalProperties: false },
);

export const LoginAccountRequestSchema = Type.Object(
  {
    username: AccountUsernameSchema,
    password: AccountPasswordSchema,
  },
  { additionalProperties: false },
);

export const AuthSessionResourceSchema = Type.Object(
  {
    identity: TenantIdentityResourceSchema,
    expiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const LogoutResourceSchema = Type.Object(
  { loggedOut: Type.Literal(true) },
  { additionalProperties: false },
);

export const CreateTenantRegistrationRequestSchema = Type.Object(
  {
    tenantSlug: Type.String({ minLength: 1, maxLength: 128 }),
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export const TenantRegistrationResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    tenantSlug: Type.String({ minLength: 1, maxLength: 64 }),
    userId: UuidSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    role: Type.Literal("owner"),
    apiToken: Type.String({
      minLength: 84,
      maxLength: 297,
      pattern:
        "^pck_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\.[A-Za-z0-9_-]{43,256}$",
    }),
  },
  { additionalProperties: false },
);

export const GitHubRepositorySourceSchema = Type.Object(
  {
    kind: Type.Literal("github_public"),
    repository: Type.String({
      minLength: 3,
      maxLength: 140,
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$",
    }),
    commitSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  },
  { additionalProperties: false },
);

export const GitHubAppRepositorySourceSchema = Type.Object(
  {
    kind: Type.Literal("github_app"),
    installationId: PositiveSafeIntegerSchema,
    repositoryId: PositiveSafeIntegerSchema,
    commitSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  },
  { additionalProperties: false },
);

export const RepositoryWorkspaceRootSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
});

export const RepositorySetEntryRequestSchema = Type.Union([
  Type.Object(
    {
      root: RepositoryWorkspaceRootSchema,
      ...GitHubRepositorySourceSchema.properties,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      root: RepositoryWorkspaceRootSchema,
      ...GitHubAppRepositorySourceSchema.properties,
    },
    { additionalProperties: false },
  ),
]);

export const RepositorySetSourceRequestSchema = Type.Object(
  {
    kind: Type.Literal("repository_set"),
    repositories: Type.Array(RepositorySetEntryRequestSchema, { minItems: 2, maxItems: 8 }),
  },
  { additionalProperties: false },
);

export const WorkspaceSourceRequestSchema = Type.Union([
  Type.Object({ kind: Type.Literal("empty") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("sample_java") }, { additionalProperties: false }),
  GitHubRepositorySourceSchema,
  GitHubAppRepositorySourceSchema,
  RepositorySetSourceRequestSchema,
]);

export const WorkspaceImportStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("importing"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);

export const WorkspaceSourceResourceSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("empty"), status: Type.Literal("ready") },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("sample_java"), status: Type.Literal("ready") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("github_public"),
      repository: Type.String({ minLength: 3, maxLength: 140 }),
      commitSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
      status: WorkspaceImportStatusSchema,
      failureCode: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("github_app"),
      installationId: PositiveSafeIntegerSchema,
      repositoryId: PositiveSafeIntegerSchema,
      repository: Type.String({ minLength: 3, maxLength: 140 }),
      commitSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
      private: Type.Boolean(),
      status: WorkspaceImportStatusSchema,
      failureCode: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("repository_set"),
      repositories: Type.Array(
        Type.Union([
          Type.Object(
            {
              root: RepositoryWorkspaceRootSchema,
              ...GitHubRepositorySourceSchema.properties,
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              root: RepositoryWorkspaceRootSchema,
              ...GitHubAppRepositorySourceSchema.properties,
              repository: Type.String({ minLength: 3, maxLength: 140 }),
              private: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ]),
        { minItems: 2, maxItems: 8 },
      ),
      status: WorkspaceImportStatusSchema,
      failureCode: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
      ),
    },
    { additionalProperties: false },
  ),
]);

export const WorkspaceSourceSetEntrySnapshotSchema = Type.Union([
  Type.Object(
    { root: Type.Literal("."), kind: Type.Literal("empty") },
    { additionalProperties: false },
  ),
  Type.Object(
    { root: Type.Literal("."), kind: Type.Literal("sample_java") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      root: Type.Union([Type.Literal("."), RepositoryWorkspaceRootSchema]),
      ...GitHubRepositorySourceSchema.properties,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      root: Type.Union([Type.Literal("."), RepositoryWorkspaceRootSchema]),
      ...GitHubAppRepositorySourceSchema.properties,
      repository: Type.String({ minLength: 3, maxLength: 140 }),
      private: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export const WorkspaceSourceSetSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    entries: Type.Array(WorkspaceSourceSetEntrySnapshotSchema, { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false },
);

export const CreateProjectRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    source: Type.Optional(WorkspaceSourceRequestSchema),
  },
  { additionalProperties: false },
);

export const ProjectResourceSchema = Type.Object(
  {
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    createdAt: UtcTimestampSchema,
    source: WorkspaceSourceResourceSchema,
    environment: ProjectEnvironmentResourceSchema,
  },
  { additionalProperties: false },
);

export const CreateSessionRequestSchema = Type.Object(
  {
    workspaceId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    sandboxRetention: Type.Optional(SandboxRetentionPolicySchema),
  },
  { additionalProperties: false },
);

export const SessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    state: Type.Literal("cold"),
    sandboxRetention: SandboxRetentionPolicySchema,
    modelProfileId: UuidSchema,
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationTurnStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("dispatching"),
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("cancelling"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const ConversationSummaryResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    workspaceName: Type.String({ minLength: 1, maxLength: 256 }),
    state: SessionStateSchema,
    sandboxRetention: SandboxRetentionPolicySchema,
    turnCount: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
    parentSessionId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

export const DelegatedSessionContextModeSchema = Type.Union([
  Type.Literal("fresh"),
  Type.Literal("fork"),
]);

export const DelegatedSessionWorkspaceModeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("shared_serialized"),
  Type.Literal("isolated"),
]);

export const DelegatedSessionStateSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("unknown"),
]);

/**
 * A delegated Pi Session is visible product history, but it is not a normal
 * human conversation fork. The parent Turn is the causal/UI anchor while the
 * context and Workspace modes describe two independent inheritance axes.
 */
export const DelegatedSessionSummaryResourceSchema = Type.Object(
  {
    executionId: UuidSchema,
    sessionId: UuidSchema,
    parentSessionId: UuidSchema,
    rootSessionId: UuidSchema,
    parentExecutionId: Type.Optional(UuidSchema),
    depth: PositiveSafeIntegerSchema,
    parentTurnId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    agentName: Type.String({ minLength: 1, maxLength: 128 }),
    contextMode: DelegatedSessionContextModeSchema,
    workspaceMode: DelegatedSessionWorkspaceModeSchema,
    state: DelegatedSessionStateSchema,
    workspaceName: Type.String({ minLength: 1, maxLength: 256 }),
    createdAt: UtcTimestampSchema,
    settledAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const ConversationListResourceSchema = Type.Object(
  {
    conversations: Type.Array(ConversationSummaryResourceSchema, { maxItems: 100 }),
    delegatedSessions: Type.Array(DelegatedSessionSummaryResourceSchema, { maxItems: 500 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ConversationSessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    state: SessionStateSchema,
    sandboxRetention: SandboxRetentionPolicySchema,
    modelProfileId: UuidSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
    parentSessionId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

export const WorkspaceSummaryResourceSchema = Type.Object(
  {
    workspaceId: UuidSchema,
    projectId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    sessionCount: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const WorkspaceListResourceSchema = Type.Object(
  {
    workspaces: Type.Array(WorkspaceSummaryResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const WorkspaceDeletionResourceSchema = Type.Object(
  {
    operationId: UuidSchema,
    workspaceId: UuidSchema,
    storageState: Type.Union([Type.Literal("pending"), Type.Literal("purged")]),
    replayed: Type.Boolean(),
    deletedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationTranscriptItemResourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("text"),
      text: Type.String(),
      firstSequence: PositiveSafeIntegerSchema,
      lastSequence: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("tool"),
      toolCallId: Type.String({ minLength: 1, maxLength: 1_024 }),
      toolName: Type.String({ minLength: 1, maxLength: 1_024 }),
      input: Type.Unknown(),
      inputJson: Type.Optional(Type.String()),
      output: Type.Optional(Type.Unknown()),
      status: Type.Union([
        Type.Literal("preparing"),
        Type.Literal("running"),
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
      ]),
      firstSequence: PositiveSafeIntegerSchema,
      lastSequence: Type.Optional(PositiveSafeIntegerSchema),
      startedAt: UtcTimestampSchema,
      completedAt: Type.Optional(UtcTimestampSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("approval"),
      approval: ApprovalRequestPayloadSchema,
      outcome: Type.Optional(
        Type.Union([Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("cancelled")]),
      ),
      value: Type.Optional(Type.String({ maxLength: 100_000 })),
      firstSequence: PositiveSafeIntegerSchema,
      lastSequence: Type.Optional(PositiveSafeIntegerSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("notification"),
      level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
      message: Type.String({ maxLength: 16_384 }),
      sequence: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ConversationTurnTranscriptResourceSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    throughSequence: PositiveSafeIntegerSchema,
    items: Type.Array(ConversationTranscriptItemResourceSchema, { maxItems: 10_000 }),
    startedSequence: Type.Union([PositiveSafeIntegerSchema, Type.Null()]),
    terminalSequence: Type.Union([PositiveSafeIntegerSchema, Type.Null()]),
    stopReason: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    failure: Type.Union([
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 256 }),
          message: Type.String({ maxLength: 16_384 }),
          retryable: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    cancellation: Type.Union([
      Type.Object(
        {
          reason: TurnCancellationReasonSchema,
          forced: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    workspacePatch: Type.Union([WorkspacePatchSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ConversationTurnResourceSchema = Type.Object(
  {
    runId: UuidSchema,
    turnId: UuidSchema,
    commandId: UuidSchema,
    mailboxPosition: PositiveSafeIntegerSchema,
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    state: ConversationTurnStateSchema,
    transcript: Type.Optional(ConversationTurnTranscriptResourceSchema),
    acceptedAt: UtcTimestampSchema,
    originSessionId: Type.Optional(UuidSchema),
    forkEntryId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

export const ConversationDetailResourceSchema = Type.Object(
  {
    project: ProjectResourceSchema,
    session: ConversationSessionResourceSchema,
    inheritedMessages: Type.Array(
      Type.Object(
        {
          entryId: Type.String({ minLength: 1, maxLength: 512 }),
          role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
          text: Type.String({ maxLength: 100_000 }),
          createdAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    turns: Type.Array(ConversationTurnResourceSchema, { maxItems: 200 }),
    historyTruncated: Type.Boolean(),
    replayAfterSequence: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const ConversationTreeViewSchema = Type.Union([Type.Literal("focus"), Type.Literal("full")]);

export const ConversationTreeEntryResourceSchema = Type.Object(
  {
    entryId: UuidSchema,
    parentEntryId: Type.Union([UuidSchema, Type.Null()]),
    turnId: UuidSchema,
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String({ maxLength: 100_000 }),
    finalAssistant: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationTreeBranchResourceSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("conversation"), Type.Literal("subagent")]),
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    parentSessionId: Type.Union([UuidSchema, Type.Null()]),
    forkedFromTurnId: Type.Union([UuidSchema, Type.Null()]),
    forkedFromEntryId: Type.Union([UuidSchema, Type.Null()]),
    current: Type.Boolean(),
    agentName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    contextMode: Type.Optional(DelegatedSessionContextModeSchema),
    workspaceMode: Type.Optional(DelegatedSessionWorkspaceModeSchema),
    delegatedState: Type.Optional(DelegatedSessionStateSchema),
    entries: Type.Array(ConversationTreeEntryResourceSchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false },
);

export const ConversationTreeResourceSchema = Type.Object(
  {
    rootSessionId: UuidSchema,
    currentSessionId: UuidSchema,
    view: ConversationTreeViewSchema,
    branches: Type.Array(ConversationTreeBranchResourceSchema, { maxItems: 100 }),
    delegatedSessions: Type.Array(DelegatedSessionSummaryResourceSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);

export const CreateConversationForkRequestSchema = Type.Object(
  {
    turnId: UuidSchema,
    entryId: UuidSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export const ConversationForkResourceSchema = Type.Object(
  {
    session: SessionResourceSchema,
    parentSessionId: UuidSchema,
    forkedFromTurnId: UuidSchema,
    forkedFromEntryId: UuidSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CreateConversationPruneRequestSchema = Type.Object(
  {
    turnId: UuidSchema,
    entryId: UuidSchema,
  },
  { additionalProperties: false },
);

export const ConversationPruneResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    anchorTurnId: UuidSchema,
    anchorEntryId: UuidSchema,
    prunedTurnCount: NonNegativeSafeIntegerSchema,
    archivedSessionCount: NonNegativeSafeIntegerSchema,
    replayed: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const LiveTurnSnapshotResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    replayAfterSequence: NonNegativeSafeIntegerSchema,
    turn: Type.Union([
      Type.Object(
        {
          turnId: UuidSchema,
          transcript: ConversationTurnTranscriptResourceSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const AcceptTurnRequestSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    thinkingLevel: Type.Optional(TurnThinkingLevelSchema),
  },
  { additionalProperties: false },
);

export const AcceptedTurnResourceSchema = Type.Object(
  {
    runId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    commandId: UuidSchema,
    mailboxPosition: PositiveSafeIntegerSchema,
    state: Type.Literal("queued"),
    acceptedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const RunStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("claimed"),
  Type.Literal("provisioning"),
  Type.Literal("restoring"),
  Type.Literal("running"),
  Type.Literal("checkpointing"),
  Type.Literal("cancel_requested"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("superseded"),
]);

export const RunAttemptStateSchema = Type.Union([
  Type.Literal("claimed"),
  Type.Literal("provisioning"),
  Type.Literal("restoring"),
  Type.Literal("running"),
  Type.Literal("checkpointing"),
  Type.Literal("cancel_requested"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("superseded"),
]);

const RunFailureResourceSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const RunAttemptTransitionResourceSchema = Type.Object(
  {
    fromState: Type.Union([RunAttemptStateSchema, Type.Null()]),
    toState: RunAttemptStateSchema,
    reason: Type.String({ minLength: 1, maxLength: 256 }),
    occurredAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const RunAttemptResourceSchema = Type.Object(
  {
    attemptId: UuidSchema,
    attemptNumber: PositiveSafeIntegerSchema,
    state: RunAttemptStateSchema,
    projection: Type.Union([Type.Literal("canonical"), Type.Literal("superseded")]),
    supersededByAttemptId: Type.Optional(UuidSchema),
    claimOwnerId: Type.String({ minLength: 1, maxLength: 256 }),
    claimExpiresAt: UtcTimestampSchema,
    sandboxId: Type.Optional(UuidSchema),
    leaseId: Type.Optional(UuidSchema),
    fencingToken: Type.Optional(PositiveSafeIntegerSchema),
    checkpointRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
    failure: Type.Optional(RunFailureResourceSchema),
    claimedAt: UtcTimestampSchema,
    provisioningAt: Type.Optional(UtcTimestampSchema),
    restoringAt: Type.Optional(UtcTimestampSchema),
    runningAt: Type.Optional(UtcTimestampSchema),
    checkpointingAt: Type.Optional(UtcTimestampSchema),
    lastHeartbeatAt: Type.Optional(UtcTimestampSchema),
    settledAt: Type.Optional(UtcTimestampSchema),
    transitions: Type.Array(RunAttemptTransitionResourceSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);

export const RunResourceSchema = Type.Object(
  {
    runId: UuidSchema,
    traceId: Type.String({ pattern: "^[0-9a-f]{32}$" }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    turnId: UuidSchema,
    commandId: UuidSchema,
    environment: EnvironmentRuntimeSnapshotSchema,
    sourceSet: WorkspaceSourceSetSnapshotSchema,
    state: RunStateSchema,
    attemptCount: NonNegativeSafeIntegerSchema,
    currentAttemptId: Type.Optional(UuidSchema),
    stopReason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    failure: Type.Optional(RunFailureResourceSchema),
    queuedAt: UtcTimestampSchema,
    startedAt: Type.Optional(UtcTimestampSchema),
    settledAt: Type.Optional(UtcTimestampSchema),
    updatedAt: UtcTimestampSchema,
    attempts: Type.Array(RunAttemptResourceSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
);

export const RunListResourceSchema = Type.Object(
  {
    runs: Type.Array(RunResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const WorkspaceVersionResourceSchema = Type.Object(
  {
    versionId: UuidSchema,
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    versionNumber: PositiveSafeIntegerSchema,
    parentVersionId: Type.Optional(UuidSchema),
    sourceVersionId: Type.Optional(UuidSchema),
    origin: Type.Union([
      Type.Literal("checkpoint"),
      Type.Literal("fork"),
      Type.Literal("migration"),
      Type.Literal("promotion"),
    ]),
    runId: Type.Optional(UuidSchema),
    attemptId: Type.Optional(UuidSchema),
    turnId: Type.Optional(UuidSchema),
    revision: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    fileCount: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
    settledAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const WorkspaceVersionListResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    currentVersionId: Type.Optional(UuidSchema),
    archived: Type.Boolean(),
    versions: Type.Array(WorkspaceVersionResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const WorkspaceFileResourceSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    executable: Type.Boolean(),
    sizeBytes: NonNegativeSafeIntegerSchema,
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

export const WorkspaceFileCursorSchema = Type.String({
  minLength: 1,
  maxLength: 512,
});

export const WorkspaceFileListResourceSchema = Type.Object(
  {
    versionId: UuidSchema,
    files: Type.Array(WorkspaceFileResourceSchema, { maxItems: 512 }),
    truncated: Type.Boolean(),
    nextCursor: Type.Optional(WorkspaceFileCursorSchema),
  },
  { additionalProperties: false },
);

export const ArchiveSessionRequestSchema = Type.Object(
  { archived: Type.Boolean() },
  { additionalProperties: false },
);

export const WorkspaceOperationResourceSchema = Type.Object(
  {
    operationId: UuidSchema,
    kind: Type.Union([Type.Literal("archive"), Type.Literal("unarchive")]),
    sessionId: UuidSchema,
    versionId: Type.Optional(UuidSchema),
    replayed: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const CreateTurnCancellationRequestSchema = Type.Object(
  {
    gracePeriodMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  },
  { additionalProperties: false },
);

export const AcceptedTurnCancellationResourceSchema = Type.Object(
  {
    commandId: UuidSchema,
    targetCommandId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    state: Type.Literal("pending"),
    acceptedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CreateTurnSteerRequestSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
  },
  { additionalProperties: false },
);

export const TurnSteerResourceSchema = Type.Object(
  {
    commandId: UuidSchema,
    targetCommandId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    state: Type.Literal("delivered"),
    acceptedAt: UtcTimestampSchema,
    deliveredAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ControlPlaneApiErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 128 }),
        message: Type.String({ minLength: 1, maxLength: 1_024 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type TurnThinkingLevel = Static<typeof TurnThinkingLevelSchema>;
export type TenantApiRole = Static<typeof TenantApiRoleSchema>;
export type TenantIdentityResource = Static<typeof TenantIdentityResourceSchema>;
export type RegisterAccountRequest = Static<typeof RegisterAccountRequestSchema>;
export type LoginAccountRequest = Static<typeof LoginAccountRequestSchema>;
export type AuthSessionResource = Static<typeof AuthSessionResourceSchema>;
export type LogoutResource = Static<typeof LogoutResourceSchema>;
export type DeepSeekModelId = Static<typeof DeepSeekModelIdSchema>;
export type ReplaceModelConfigurationRequest = Static<
  typeof ReplaceModelConfigurationRequestSchema
>;
export type ModelConfigurationResource = Static<typeof ModelConfigurationResourceSchema>;
export type ReplaceCubeProxyConfigurationRequest = Static<
  typeof ReplaceCubeProxyConfigurationRequestSchema
>;
export type CubeProxyConfigurationResource = Static<typeof CubeProxyConfigurationResourceSchema>;
export type InternalCubeProxyConfigurationResource = Static<
  typeof InternalCubeProxyConfigurationResourceSchema
>;
export type CreateTenantRegistrationRequest = Static<typeof CreateTenantRegistrationRequestSchema>;
export type TenantRegistrationResource = Static<typeof TenantRegistrationResourceSchema>;
export type GitHubRepositorySource = Static<typeof GitHubRepositorySourceSchema>;
export type GitHubAppRepositorySource = Static<typeof GitHubAppRepositorySourceSchema>;
export type RepositorySetEntryRequest = Static<typeof RepositorySetEntryRequestSchema>;
export type RepositorySetSourceRequest = Static<typeof RepositorySetSourceRequestSchema>;
export type WorkspaceSourceRequest = Static<typeof WorkspaceSourceRequestSchema>;
export type WorkspaceImportStatus = Static<typeof WorkspaceImportStatusSchema>;
export type WorkspaceSourceResource = Static<typeof WorkspaceSourceResourceSchema>;
export type WorkspaceSourceSetEntrySnapshot = Static<typeof WorkspaceSourceSetEntrySnapshotSchema>;
export type WorkspaceSourceSetSnapshot = Static<typeof WorkspaceSourceSetSnapshotSchema>;
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;
export type ProjectResource = Static<typeof ProjectResourceSchema>;
export type { SandboxRetentionPolicy } from "./protocol-primitives.ts";
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type SessionResource = Static<typeof SessionResourceSchema>;
export type WorkspaceSummaryResource = Static<typeof WorkspaceSummaryResourceSchema>;
export type WorkspaceListResource = Static<typeof WorkspaceListResourceSchema>;
export type WorkspaceDeletionResource = Static<typeof WorkspaceDeletionResourceSchema>;
export type ConversationTurnState = Static<typeof ConversationTurnStateSchema>;
export type ConversationSummaryResource = Static<typeof ConversationSummaryResourceSchema>;
export type DelegatedSessionContextMode = Static<typeof DelegatedSessionContextModeSchema>;
export type DelegatedSessionWorkspaceMode = Static<typeof DelegatedSessionWorkspaceModeSchema>;
export type DelegatedSessionState = Static<typeof DelegatedSessionStateSchema>;
export type DelegatedSessionSummaryResource = Static<typeof DelegatedSessionSummaryResourceSchema>;
export type ConversationListResource = Static<typeof ConversationListResourceSchema>;
export type ConversationSessionResource = Static<typeof ConversationSessionResourceSchema>;
export type ConversationTranscriptItemResource = Static<
  typeof ConversationTranscriptItemResourceSchema
>;
export type ConversationTurnTranscriptResource = Static<
  typeof ConversationTurnTranscriptResourceSchema
>;
export type ConversationTurnResource = Static<typeof ConversationTurnResourceSchema>;
export type ConversationDetailResource = Static<typeof ConversationDetailResourceSchema>;
export type ConversationTreeView = Static<typeof ConversationTreeViewSchema>;
export type ConversationTreeEntryResource = Static<typeof ConversationTreeEntryResourceSchema>;
export type ConversationTreeBranchResource = Static<typeof ConversationTreeBranchResourceSchema>;
export type ConversationTreeResource = Static<typeof ConversationTreeResourceSchema>;
export type CreateConversationForkRequest = Static<typeof CreateConversationForkRequestSchema>;
export type ConversationForkResource = Static<typeof ConversationForkResourceSchema>;
export type CreateConversationPruneRequest = Static<typeof CreateConversationPruneRequestSchema>;
export type ConversationPruneResource = Static<typeof ConversationPruneResourceSchema>;
export type LiveTurnSnapshotResource = Static<typeof LiveTurnSnapshotResourceSchema>;
export type AcceptTurnRequest = Static<typeof AcceptTurnRequestSchema>;
export type AcceptedTurnResource = Static<typeof AcceptedTurnResourceSchema>;
export type RunState = Static<typeof RunStateSchema>;
export type RunAttemptState = Static<typeof RunAttemptStateSchema>;
export type RunAttemptTransitionResource = Static<typeof RunAttemptTransitionResourceSchema>;
export type RunAttemptResource = Static<typeof RunAttemptResourceSchema>;
export type RunResource = Static<typeof RunResourceSchema>;
export type RunListResource = Static<typeof RunListResourceSchema>;
export type WorkspaceVersionResource = Static<typeof WorkspaceVersionResourceSchema>;
export type WorkspaceVersionListResource = Static<typeof WorkspaceVersionListResourceSchema>;
export type WorkspaceFileResource = Static<typeof WorkspaceFileResourceSchema>;
export type WorkspaceFileListResource = Static<typeof WorkspaceFileListResourceSchema>;
export type ArchiveSessionRequest = Static<typeof ArchiveSessionRequestSchema>;
export type WorkspaceOperationResource = Static<typeof WorkspaceOperationResourceSchema>;
export type CreateTurnCancellationRequest = Static<typeof CreateTurnCancellationRequestSchema>;
export type AcceptedTurnCancellationResource = Static<
  typeof AcceptedTurnCancellationResourceSchema
>;
export type CreateTurnSteerRequest = Static<typeof CreateTurnSteerRequestSchema>;
export type TurnSteerResource = Static<typeof TurnSteerResourceSchema>;
export type ControlPlaneApiError = Static<typeof ControlPlaneApiErrorSchema>;

export class ControlPlaneApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneApiValidationError";
  }
}

export const DEFAULT_SAMPLE_WORKSPACE_SOURCE_SET = {
  schemaVersion: 1,
  entries: [{ root: ".", kind: "sample_java" }],
} as const satisfies WorkspaceSourceSetSnapshot;

function parseSchema<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  description: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new ControlPlaneApiValidationError(
      `Invalid ${description} at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as Static<Schema>;
}

function normalizedPublicGitHubRepository(value: string): string {
  const repository = value.trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(
      repository,
    ) ||
    repository.includes("..") ||
    repository.endsWith(".git")
  ) {
    throw new ControlPlaneApiValidationError(
      "GitHub repository must be a normalized public owner/repository coordinate",
    );
  }
  return repository;
}

export function parseCreateProjectRequest(value: unknown): CreateProjectRequest {
  const request = parseSchema(CreateProjectRequestSchema, value, "create-project request");
  const name = request.name.trim();
  if (name.length === 0) {
    throw new ControlPlaneApiValidationError(
      "Project name must contain a non-whitespace character",
    );
  }
  if (request.source?.kind === "sample_java") {
    return { name, source: { kind: "sample_java" } };
  }
  if (request.source === undefined || request.source.kind === "empty") {
    return { name, source: { kind: "empty" } };
  }
  if (request.source.kind === "repository_set") {
    const roots = new Set<string>();
    const identities = new Set<string>();
    const repositories = request.source.repositories.map((entry) => {
      if (roots.has(entry.root)) {
        throw new ControlPlaneApiValidationError("Repository-set Workspace roots must be unique");
      }
      roots.add(entry.root);
      if (entry.kind === "github_app") {
        const identity = `github_app:${String(entry.installationId)}:${String(entry.repositoryId)}`;
        if (identities.has(identity)) {
          throw new ControlPlaneApiValidationError(
            "Repository-set entries must identify distinct repositories",
          );
        }
        identities.add(identity);
        return { ...entry, commitSha: entry.commitSha.toLowerCase() };
      }
      const repository = normalizedPublicGitHubRepository(entry.repository);
      const identity = `github_public:${repository}`;
      if (identities.has(identity)) {
        throw new ControlPlaneApiValidationError(
          "Repository-set entries must identify distinct repositories",
        );
      }
      identities.add(identity);
      return { ...entry, repository, commitSha: entry.commitSha.toLowerCase() };
    });
    return { name, source: { kind: "repository_set", repositories } };
  }
  if (request.source.kind === "github_app") {
    return {
      name,
      source: {
        ...request.source,
        commitSha: request.source.commitSha.toLowerCase(),
      },
    };
  }
  const repository = normalizedPublicGitHubRepository(request.source.repository);
  const commitSha = request.source.commitSha.toLowerCase();
  return {
    name,
    source: { kind: "github_public", repository, commitSha },
  };
}

export function parseWorkspaceSourceSetSnapshot(value: unknown): WorkspaceSourceSetSnapshot {
  const snapshot = parseSchema(
    WorkspaceSourceSetSnapshotSchema,
    value,
    "Workspace source-set snapshot",
  );
  const roots = new Set<string>();
  const identities = new Set<string>();
  for (const entry of snapshot.entries) {
    if (roots.has(entry.root)) {
      throw new ControlPlaneApiValidationError("Workspace source-set roots must be unique");
    }
    roots.add(entry.root);
    if (entry.kind === "empty" || entry.kind === "sample_java") {
      if (snapshot.entries.length !== 1 || entry.root !== ".") {
        throw new ControlPlaneApiValidationError(
          "Built-in Workspace sources cannot be combined with repositories",
        );
      }
      continue;
    }
    if (snapshot.entries.length > 1 && entry.root === ".") {
      throw new ControlPlaneApiValidationError(
        "Multi-repository Workspace entries require disjoint named roots",
      );
    }
    const identity =
      entry.kind === "github_public"
        ? `github_public:${entry.repository}`
        : `github_app:${String(entry.installationId)}:${String(entry.repositoryId)}`;
    if (identities.has(identity)) {
      throw new ControlPlaneApiValidationError(
        "Workspace source-set entries must identify distinct repositories",
      );
    }
    identities.add(identity);
  }
  return {
    schemaVersion: 1,
    entries: [...snapshot.entries].sort((left, right) => left.root.localeCompare(right.root)),
  };
}

export function canonicalWorkspaceSourceSetJson(value: unknown): string {
  const snapshot = parseWorkspaceSourceSetSnapshot(value);
  return JSON.stringify({
    schemaVersion: 1,
    entries: snapshot.entries.map((entry) => {
      if (entry.kind === "empty" || entry.kind === "sample_java") {
        return { root: entry.root, kind: entry.kind };
      }
      if (entry.kind === "github_public") {
        return {
          root: entry.root,
          kind: entry.kind,
          repository: entry.repository,
          commitSha: entry.commitSha,
        };
      }
      return {
        root: entry.root,
        kind: entry.kind,
        installationId: entry.installationId,
        repositoryId: entry.repositoryId,
        repository: entry.repository,
        commitSha: entry.commitSha,
        private: entry.private,
      };
    }),
  });
}

export function parseTenantIdentityResource(value: unknown): TenantIdentityResource {
  return parseSchema(TenantIdentityResourceSchema, value, "tenant identity resource");
}

function normalizedAccountPassword(value: string): string {
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength < 10 || byteLength > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ControlPlaneApiValidationError(
      "Password must contain 10-128 characters and at most 256 safe UTF-8 bytes",
    );
  }
  return value;
}

export function parseRegisterAccountRequest(value: unknown): RegisterAccountRequest {
  const request = parseSchema(RegisterAccountRequestSchema, value, "account registration request");
  const username = request.username.trim().toLowerCase();
  const displayName = request.displayName.trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,47}$/.test(username)) {
    throw new ControlPlaneApiValidationError(
      "Username must contain 3-48 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  if (
    displayName.length === 0 ||
    new TextEncoder().encode(displayName).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new ControlPlaneApiValidationError("Display name must contain 1-256 safe UTF-8 bytes");
  }
  return { username, displayName, password: normalizedAccountPassword(request.password) };
}

export function parseLoginAccountRequest(value: unknown): LoginAccountRequest {
  const request = parseSchema(LoginAccountRequestSchema, value, "account login request");
  return {
    username: request.username.trim().toLowerCase(),
    password: normalizedAccountPassword(request.password),
  };
}

export function parseAuthSessionResource(value: unknown): AuthSessionResource {
  return parseSchema(AuthSessionResourceSchema, value, "authenticated web session resource");
}

export function parseLogoutResource(value: unknown): LogoutResource {
  return parseSchema(LogoutResourceSchema, value, "logout resource");
}

export function parseReplaceModelConfigurationRequest(
  value: unknown,
): ReplaceModelConfigurationRequest {
  return parseSchema(
    ReplaceModelConfigurationRequestSchema,
    value,
    "replace-model-configuration request",
  );
}

export function parseModelConfigurationResource(value: unknown): ModelConfigurationResource {
  return parseSchema(ModelConfigurationResourceSchema, value, "model configuration resource");
}

export function parseReplaceCubeProxyConfigurationRequest(
  value: unknown,
): ReplaceCubeProxyConfigurationRequest {
  return parseSchema(
    ReplaceCubeProxyConfigurationRequestSchema,
    value,
    "replace Cube proxy configuration request",
  );
}

export function parseCubeProxyConfigurationResource(
  value: unknown,
): CubeProxyConfigurationResource {
  return parseSchema(
    CubeProxyConfigurationResourceSchema,
    value,
    "Cube proxy configuration resource",
  );
}

export function parseInternalCubeProxyConfigurationResource(
  value: unknown,
): InternalCubeProxyConfigurationResource {
  return parseSchema(
    InternalCubeProxyConfigurationResourceSchema,
    value,
    "internal Cube proxy configuration resource",
  );
}

export function parseCreateTenantRegistrationRequest(
  value: unknown,
): CreateTenantRegistrationRequest {
  const request = parseSchema(
    CreateTenantRegistrationRequestSchema,
    value,
    "tenant registration request",
  );
  const tenantSlug = request.tenantSlug.trim().toLowerCase();
  const displayName = request.displayName.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(tenantSlug)) {
    throw new ControlPlaneApiValidationError(
      "Tenant slug must contain 1-64 lowercase letters, digits, or hyphens",
    );
  }
  if (
    displayName.length === 0 ||
    new TextEncoder().encode(displayName).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new ControlPlaneApiValidationError("Display name must contain 1-256 safe UTF-8 bytes");
  }
  return { tenantSlug, displayName };
}

export function parseTenantRegistrationResource(value: unknown): TenantRegistrationResource {
  return parseSchema(TenantRegistrationResourceSchema, value, "tenant registration resource");
}

export function parseCreateSessionRequest(
  value: unknown,
): CreateSessionRequest & { sandboxRetention: Static<typeof SandboxRetentionPolicySchema> } {
  const request = parseSchema(CreateSessionRequestSchema, value, "create-session request");
  const title = request.title.trim();
  if (
    title.length === 0 ||
    new TextEncoder().encode(title).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(title)
  ) {
    throw new ControlPlaneApiValidationError(
      "Conversation title must contain 1-256 safe UTF-8 bytes",
    );
  }
  return { ...request, title, sandboxRetention: request.sandboxRetention ?? "ephemeral" };
}

export function parseAcceptTurnRequest(value: unknown): AcceptTurnRequest {
  const request = parseSchema(AcceptTurnRequestSchema, value, "accept-turn request");
  if (request.prompt.trim().length === 0) {
    throw new ControlPlaneApiValidationError("Turn prompt must contain a non-whitespace character");
  }
  return request;
}

export function parseCreateTurnCancellationRequest(value: unknown): CreateTurnCancellationRequest {
  return parseSchema(
    CreateTurnCancellationRequestSchema,
    value,
    "create-turn-cancellation request",
  );
}

export function parseCreateTurnSteerRequest(value: unknown): CreateTurnSteerRequest {
  const request = parseSchema(CreateTurnSteerRequestSchema, value, "create-turn-steer request");
  if (request.text.trim().length === 0) {
    throw new ControlPlaneApiValidationError("Steer text must contain a non-whitespace character");
  }
  return request;
}

export function parseProjectResource(value: unknown): ProjectResource {
  return parseSchema(ProjectResourceSchema, value, "project resource");
}

export function parseSessionResource(value: unknown): SessionResource {
  return parseSchema(SessionResourceSchema, value, "session resource");
}

export function parseWorkspaceListResource(value: unknown): WorkspaceListResource {
  return parseSchema(WorkspaceListResourceSchema, value, "workspace list resource");
}

export function parseWorkspaceDeletionResource(value: unknown): WorkspaceDeletionResource {
  return parseSchema(WorkspaceDeletionResourceSchema, value, "workspace deletion resource");
}

export function parseConversationListResource(value: unknown): ConversationListResource {
  return parseSchema(ConversationListResourceSchema, value, "conversation list resource");
}

export function parseConversationDetailResource(value: unknown): ConversationDetailResource {
  return parseSchema(ConversationDetailResourceSchema, value, "conversation detail resource");
}

export function parseConversationTreeView(value: unknown): ConversationTreeView {
  return value === undefined
    ? "focus"
    : parseSchema(ConversationTreeViewSchema, value, "conversation tree view");
}

export function parseConversationTreeResource(value: unknown): ConversationTreeResource {
  return parseSchema(ConversationTreeResourceSchema, value, "conversation tree resource");
}

export function parseCreateConversationForkRequest(value: unknown): CreateConversationForkRequest {
  const request = parseSchema(
    CreateConversationForkRequestSchema,
    value,
    "create-conversation-fork request",
  );
  if (request.title === undefined) return request;
  const title = request.title.trim();
  if (
    title.length === 0 ||
    new TextEncoder().encode(title).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(title)
  ) {
    throw new ControlPlaneApiValidationError("Fork title must contain 1-256 safe UTF-8 bytes");
  }
  return { ...request, title };
}

export function parseConversationForkResource(value: unknown): ConversationForkResource {
  return parseSchema(ConversationForkResourceSchema, value, "conversation fork resource");
}

export function parseCreateConversationPruneRequest(
  value: unknown,
): CreateConversationPruneRequest {
  return parseSchema(CreateConversationPruneRequestSchema, value, "conversation prune request");
}

export function parseConversationPruneResource(value: unknown): ConversationPruneResource {
  return parseSchema(ConversationPruneResourceSchema, value, "conversation prune resource");
}

export function parseLiveTurnSnapshotResource(value: unknown): LiveTurnSnapshotResource {
  return parseSchema(LiveTurnSnapshotResourceSchema, value, "live Turn snapshot resource");
}

export function parseConversationTurnTranscriptResource(
  value: unknown,
): ConversationTurnTranscriptResource {
  return parseSchema(
    ConversationTurnTranscriptResourceSchema,
    value,
    "conversation turn transcript resource",
  );
}

export function parseAcceptedTurnResource(value: unknown): AcceptedTurnResource {
  return parseSchema(AcceptedTurnResourceSchema, value, "accepted-turn resource");
}

export function parseRunResource(value: unknown): RunResource {
  return parseSchema(RunResourceSchema, value, "run resource");
}

export function parseRunListResource(value: unknown): RunListResource {
  return parseSchema(RunListResourceSchema, value, "run list resource");
}

export function parseArchiveSessionRequest(value: unknown): ArchiveSessionRequest {
  return parseSchema(ArchiveSessionRequestSchema, value, "archive-session request");
}

export function parseWorkspaceVersionResource(value: unknown): WorkspaceVersionResource {
  return parseSchema(WorkspaceVersionResourceSchema, value, "workspace-version resource");
}

export function parseWorkspaceVersionListResource(value: unknown): WorkspaceVersionListResource {
  return parseSchema(WorkspaceVersionListResourceSchema, value, "workspace-version-list resource");
}

export function parseWorkspaceFileListResource(value: unknown): WorkspaceFileListResource {
  return parseSchema(WorkspaceFileListResourceSchema, value, "workspace-file-list resource");
}

export function parseWorkspaceFileCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return parseSchema(WorkspaceFileCursorSchema, value, "workspace-file cursor");
}

export function parseWorkspaceOperationResource(value: unknown): WorkspaceOperationResource {
  return parseSchema(WorkspaceOperationResourceSchema, value, "workspace-operation resource");
}

export function parseAcceptedTurnCancellationResource(
  value: unknown,
): AcceptedTurnCancellationResource {
  return parseSchema(
    AcceptedTurnCancellationResourceSchema,
    value,
    "accepted-turn-cancellation resource",
  );
}

export function parseTurnSteerResource(value: unknown): TurnSteerResource {
  return parseSchema(TurnSteerResourceSchema, value, "turn-steer resource");
}

export function parseControlPlaneApiError(value: unknown): ControlPlaneApiError {
  return parseSchema(ControlPlaneApiErrorSchema, value, "control-plane API error");
}

export function parseIdempotencyKey(value: unknown): string {
  return parseSchema(IdempotencyKeySchema, value, "Idempotency-Key header");
}

export function parseUuidPathParameter(value: unknown, name: string): string {
  return parseSchema(UuidSchema, value, `${name} path parameter`);
}

export function parsePositiveIntegerPathParameter(value: unknown, name: string): number {
  const normalized = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  return parseSchema(PositiveSafeIntegerSchema, normalized, `${name} path parameter`);
}

export function parseLastEventIdHeader(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new ControlPlaneApiValidationError(
      "Last-Event-ID must be a canonical non-negative integer",
    );
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new ControlPlaneApiValidationError(
      "Last-Event-ID is outside the supported integer range",
    );
  }
  return sequence;
}
