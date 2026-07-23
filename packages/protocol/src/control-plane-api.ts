import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
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
  EnvironmentValidationReportSchema,
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
      provider: Type.Literal("agent-dock-fake"),
      modelId: Type.Literal("agent-dock-fake"),
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

const ModelGovernanceLimitsSchema = Type.Object(
  {
    maximumModelRequestsPerRun: Type.Integer({ minimum: 1, maximum: 1_024 }),
    maximumCostMicrousdPerRun: Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
    dailyTokenBudget: Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
    monthlyCostMicrousdBudget: Type.Integer({
      minimum: 1,
      maximum: 1_000_000_000_000_000,
    }),
    maximumToolCallsPerRun: Type.Integer({ minimum: 1, maximum: 10_000 }),
    maximumToolOutputBytes: Type.Integer({ minimum: 1_024, maximum: 1_048_576 }),
    maximumRunDurationMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    compactionReserveTokens: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
    compactionKeepRecentTokens: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);

const ModelRateResourceSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    inputMicrousdPerMillion: NonNegativeSafeIntegerSchema,
    outputMicrousdPerMillion: NonNegativeSafeIntegerSchema,
    cacheReadMicrousdPerMillion: NonNegativeSafeIntegerSchema,
    cacheWriteMicrousdPerMillion: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

const ReplaceModelRateSchema = Type.Object(
  {
    provider: Type.Literal("deepseek"),
    modelId: DeepSeekModelIdSchema,
    inputMicrousdPerMillion: NonNegativeSafeIntegerSchema,
    outputMicrousdPerMillion: NonNegativeSafeIntegerSchema,
    cacheReadMicrousdPerMillion: NonNegativeSafeIntegerSchema,
    cacheWriteMicrousdPerMillion: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

const ModelFallbackPolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    provider: Type.Optional(Type.Literal("deepseek")),
    modelId: Type.Optional(DeepSeekModelIdSchema),
    onRateLimit: Type.Boolean(),
    onServerError: Type.Boolean(),
    onTimeout: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ReplaceModelGovernanceRequestSchema = Type.Object(
  {
    limits: ModelGovernanceLimitsSchema,
    rates: Type.Array(ReplaceModelRateSchema, { minItems: 1, maxItems: 2 }),
    fallback: ModelFallbackPolicySchema,
  },
  { additionalProperties: false },
);

export const ModelGovernanceResourceSchema = Type.Object(
  {
    limits: ModelGovernanceLimitsSchema,
    rates: Type.Array(ModelRateResourceSchema, { maxItems: 32 }),
    fallback: ModelFallbackPolicySchema,
    updatedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

const UsageTotalsSchema = Type.Object(
  {
    requests: NonNegativeSafeIntegerSchema,
    inputTokens: NonNegativeSafeIntegerSchema,
    outputTokens: NonNegativeSafeIntegerSchema,
    cacheReadTokens: NonNegativeSafeIntegerSchema,
    cacheWriteTokens: NonNegativeSafeIntegerSchema,
    costMicrousd: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const UsageSummaryResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    totals: UsageTotalsSchema,
    byModel: Type.Array(
      Type.Object(
        {
          provider: Type.String({ minLength: 1, maxLength: 128 }),
          modelId: Type.String({ minLength: 1, maxLength: 256 }),
          totals: UsageTotalsSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

const DurationQuantilesResourceSchema = Type.Object(
  {
    sampleCount: NonNegativeSafeIntegerSchema,
    p50Ms: NonNegativeSafeIntegerSchema,
    p95Ms: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const OperationalInsightsResourceSchema = Type.Object(
  {
    generatedAt: UtcTimestampSchema,
    windowStartedAt: UtcTimestampSchema,
    runs: Type.Object(
      {
        queued: NonNegativeSafeIntegerSchema,
        active: NonNegativeSafeIntegerSchema,
        completed: NonNegativeSafeIntegerSchema,
        failed: NonNegativeSafeIntegerSchema,
        cancelled: NonNegativeSafeIntegerSchema,
        timedOut: NonNegativeSafeIntegerSchema,
        retriedAttempts: NonNegativeSafeIntegerSchema,
        successRateBasisPoints: Type.Integer({ minimum: 0, maximum: 10_000 }),
        queueWait: DurationQuantilesResourceSchema,
        execution: DurationQuantilesResourceSchema,
      },
      { additionalProperties: false },
    ),
    model: Type.Object(
      {
        requests: NonNegativeSafeIntegerSchema,
        failures: NonNegativeSafeIntegerSchema,
        inputTokens: NonNegativeSafeIntegerSchema,
        outputTokens: NonNegativeSafeIntegerSchema,
        cacheReadTokens: NonNegativeSafeIntegerSchema,
        cacheWriteTokens: NonNegativeSafeIntegerSchema,
        costMicrousd: NonNegativeSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    tools: Type.Object(
      {
        calls: NonNegativeSafeIntegerSchema,
        failures: NonNegativeSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    quality: Type.Object(
      {
        testsPassed: NonNegativeSafeIntegerSchema,
        testsFailed: NonNegativeSafeIntegerSchema,
        testsErrored: NonNegativeSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    activeSandboxAssignments: NonNegativeSafeIntegerSchema,
    failures: Type.Array(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 128 }),
          count: PositiveSafeIntegerSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

export const OperationalAuditEventResourceSchema = Type.Object(
  {
    eventId: UuidSchema,
    category: Type.Union([
      Type.Literal("run_attempt"),
      Type.Literal("workspace"),
      Type.Literal("model"),
      Type.Literal("github"),
      Type.Literal("environment"),
    ]),
    action: Type.String({ minLength: 1, maxLength: 128 }),
    state: Type.String({ minLength: 1, maxLength: 128 }),
    subjectId: UuidSchema,
    summary: Type.String({ minLength: 1, maxLength: 1_024 }),
    occurredAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const OperationalAuditLogResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    events: Type.Array(OperationalAuditEventResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

const ModelRequestAuditResourceSchema = Type.Object(
  {
    requestId: UuidSchema,
    sequence: PositiveSafeIntegerSchema,
    state: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("aborted"),
      Type.Literal("budget_denied"),
    ]),
    requestedProvider: Type.String({ minLength: 1, maxLength: 128 }),
    requestedModelId: Type.String({ minLength: 1, maxLength: 256 }),
    actualProvider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    actualModelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    fallbackReason: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    reservedTokens: NonNegativeSafeIntegerSchema,
    actualTokens: Type.Optional(NonNegativeSafeIntegerSchema),
    reservedCostMicrousd: NonNegativeSafeIntegerSchema,
    actualCostMicrousd: Type.Optional(NonNegativeSafeIntegerSchema),
    actualRate: Type.Optional(
      Type.Object(
        {
          inputMicrousdPerMillion: NonNegativeSafeIntegerSchema,
          outputMicrousdPerMillion: NonNegativeSafeIntegerSchema,
          cacheReadMicrousdPerMillion: NonNegativeSafeIntegerSchema,
          cacheWriteMicrousdPerMillion: NonNegativeSafeIntegerSchema,
        },
        { additionalProperties: false },
      ),
    ),
    startedAt: UtcTimestampSchema,
    settledAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const RunUsageResourceSchema = Type.Object(
  {
    runId: UuidSchema,
    totals: UsageTotalsSchema,
    modelRequests: Type.Array(ModelRequestAuditResourceSchema, { maxItems: 1_024 }),
  },
  { additionalProperties: false },
);

export const SessionContextResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    compaction: Type.Object(
      {
        reserveTokens: PositiveSafeIntegerSchema,
        keepRecentTokens: PositiveSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    layers: Type.Array(
      Type.Object(
        {
          order: Type.Integer({ minimum: 0, maximum: 5 }),
          kind: Type.Union([
            Type.Literal("platform_system"),
            Type.Literal("project_instructions"),
            Type.Literal("session_summary"),
            Type.Literal("recent_messages"),
            Type.Literal("tool_results"),
            Type.Literal("current_task"),
          ]),
          source: Type.String({ minLength: 1, maxLength: 128 }),
          availability: Type.Union([Type.Literal("always"), Type.Literal("when_available")]),
          maximumBytes: Type.Optional(PositiveSafeIntegerSchema),
        },
        { additionalProperties: false },
      ),
      { minItems: 6, maxItems: 6 },
    ),
    history: Type.Array(
      Type.Object(
        {
          compactionId: UuidSchema,
          turnId: UuidSchema,
          runId: UuidSchema,
          attemptId: UuidSchema,
          reason: Type.Union([
            Type.Literal("manual"),
            Type.Literal("threshold"),
            Type.Literal("overflow"),
          ]),
          state: Type.Union([
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("aborted"),
            Type.Literal("failed"),
          ]),
          tokensBefore: Type.Optional(NonNegativeSafeIntegerSchema),
          estimatedTokensAfter: Type.Optional(NonNegativeSafeIntegerSchema),
          summarySha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
          summaryVersion: Type.Optional(PositiveSafeIntegerSchema),
          willRetry: Type.Boolean(),
          startedAt: UtcTimestampSchema,
          completedAt: Type.Optional(UtcTimestampSchema),
        },
        { additionalProperties: false },
      ),
      { maxItems: 200 },
    ),
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
        "^adk_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\.[A-Za-z0-9_-]{43,256}$",
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
  },
  { additionalProperties: false },
);

export const SessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    state: Type.Literal("cold"),
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
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    projectName: Type.String({ minLength: 1, maxLength: 256 }),
    state: SessionStateSchema,
    turnCount: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationListResourceSchema = Type.Object(
  {
    conversations: Type.Array(ConversationSummaryResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ConversationSessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    state: SessionStateSchema,
    modelProfileId: UuidSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
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
    projection: Type.Union([Type.Literal("canonical"), Type.Literal("superseded")]),
    supersededByRunId: Type.Optional(UuidSchema),
    rewoundFromRunId: Type.Optional(UuidSchema),
    transcript: Type.Optional(ConversationTurnTranscriptResourceSchema),
    acceptedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationDetailResourceSchema = Type.Object(
  {
    project: ProjectResourceSchema,
    session: ConversationSessionResourceSchema,
    turns: Type.Array(ConversationTurnResourceSchema, { maxItems: 200 }),
    historyTruncated: Type.Boolean(),
    replayAfterSequence: NonNegativeSafeIntegerSchema,
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
    projection: Type.Union([Type.Literal("canonical"), Type.Literal("superseded")]),
    supersededByRunId: Type.Optional(UuidSchema),
    rewoundFrom: Type.Optional(
      Type.Object(
        {
          sourceRunId: UuidSchema,
          sourceAttemptId: UuidSchema,
          conversationBoundarySeq: NonNegativeSafeIntegerSchema,
        },
        { additionalProperties: false },
      ),
    ),
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

export const TestResultResourceSchema = Type.Object(
  {
    testResultId: UuidSchema,
    runId: UuidSchema,
    workspaceVersionId: Type.Optional(UuidSchema),
    toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
    command: Type.String({ minLength: 1, maxLength: 4_096 }),
    suite: Type.String({ minLength: 1, maxLength: 256 }),
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("errored")]),
    exitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
    durationMs: Type.Optional(NonNegativeSafeIntegerSchema),
    summary: Type.Optional(Type.String({ maxLength: 2_000 })),
    artifactId: Type.Optional(UuidSchema),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const TestResultListResourceSchema = Type.Object(
  { runId: UuidSchema, results: Type.Array(TestResultResourceSchema, { maxItems: 100 }) },
  { additionalProperties: false },
);

export const CreateRunRewindRequestSchema = Type.Object(
  { sourceAttemptId: UuidSchema },
  { additionalProperties: false },
);

export const RunRewindResourceSchema = Type.Object(
  {
    rewindId: UuidSchema,
    sourceRunId: UuidSchema,
    sourceAttemptId: UuidSchema,
    replacementRunId: UuidSchema,
    conversationBoundarySeq: NonNegativeSafeIntegerSchema,
    workspaceBaseVersionId: Type.Optional(UuidSchema),
    piSessionBaseArtifactId: Type.Optional(UuidSchema),
    acceptedTurn: AcceptedTurnResourceSchema,
    replayed: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

const ReviewBundleArtifactSchema = Type.Object(
  {
    artifactId: UuidSchema,
    kind: Type.Union([
      Type.Literal("pi_session_snapshot"),
      Type.Literal("workspace_snapshot"),
      Type.Literal("tool_output"),
      Type.Literal("patch"),
      Type.Literal("report"),
      Type.Literal("crash_bundle"),
    ]),
    fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sizeBytes: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

const ReviewBundleAttemptSchema = Type.Object(
  {
    attemptId: UuidSchema,
    attemptNumber: PositiveSafeIntegerSchema,
    state: RunAttemptStateSchema,
    projection: Type.Union([Type.Literal("canonical"), Type.Literal("superseded")]),
    failure: Type.Optional(RunFailureResourceSchema),
    claimedAt: UtcTimestampSchema,
    settledAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const ReviewBundleManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    run: Type.Object(
      {
        runId: UuidSchema,
        traceId: Type.String({ pattern: "^[0-9a-f]{32}$" }),
        projectId: UuidSchema,
        workspaceId: UuidSchema,
        sessionId: UuidSchema,
        turnId: UuidSchema,
        attemptId: UuidSchema,
        stopReason: Type.String({ minLength: 1, maxLength: 256 }),
        queuedAt: UtcTimestampSchema,
        startedAt: Type.Optional(UtcTimestampSchema),
        settledAt: UtcTimestampSchema,
      },
      { additionalProperties: false },
    ),
    environment: EnvironmentRuntimeSnapshotSchema,
    sourceSet: WorkspaceSourceSetSnapshotSchema,
    attempts: Type.Array(ReviewBundleAttemptSchema, { minItems: 1, maxItems: 32 }),
    assistant: Type.Object(
      {
        text: Type.String({ maxLength: 100_000 }),
        textSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        firstSeq: Type.Optional(PositiveSafeIntegerSchema),
        lastSeq: Type.Optional(PositiveSafeIntegerSchema),
        truncated: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    changes: Type.Object(
      {
        workspaceVersionId: Type.Optional(UuidSchema),
        patchArtifactId: Type.Optional(UuidSchema),
        patchSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
        changedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
          maxItems: 1_000,
        }),
      },
      { additionalProperties: false },
    ),
    tests: Type.Array(
      Type.Object(
        {
          testResultId: UuidSchema,
          toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
          suite: Type.String({ minLength: 1, maxLength: 256 }),
          command: Type.String({ minLength: 1, maxLength: 4_096 }),
          status: Type.Union([
            Type.Literal("passed"),
            Type.Literal("failed"),
            Type.Literal("errored"),
          ]),
          exitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
          durationMs: Type.Optional(NonNegativeSafeIntegerSchema),
          summary: Type.Optional(Type.String({ maxLength: 2_000 })),
          artifactId: Type.Optional(UuidSchema),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    artifacts: Type.Array(ReviewBundleArtifactSchema, { maxItems: 1_000 }),
    usage: Type.Object(
      {
        requests: NonNegativeSafeIntegerSchema,
        inputTokens: NonNegativeSafeIntegerSchema,
        outputTokens: NonNegativeSafeIntegerSchema,
        cacheReadTokens: NonNegativeSafeIntegerSchema,
        cacheWriteTokens: NonNegativeSafeIntegerSchema,
        costMicrousd: NonNegativeSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    environmentValidation: Type.Optional(
      Type.Object(
        {
          status: Type.Union([Type.Literal("validated"), Type.Literal("failed")]),
          report: Type.Optional(EnvironmentValidationReportSchema),
          reportSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
          failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          validatedAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ReviewBundleResourceSchema = Type.Object(
  {
    reviewBundleId: UuidSchema,
    manifestSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    manifest: ReviewBundleManifestSchema,
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const CandidateRaceAcceptancePolicySchema = Type.Object(
  {
    requirePatch: Type.Boolean(),
    requireTests: Type.Boolean(),
    maximumChangedPaths: Type.Integer({ minimum: 1, maximum: 1_000 }),
    protectedPathPrefixes: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 256,
        pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\u0000-\\u001f\\u007f\\\\]+$",
      }),
      { maxItems: 32, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

const CandidateRaceCandidateInputSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 128 }),
    strategy: Type.String({ minLength: 1, maxLength: 4_096 }),
  },
  { additionalProperties: false },
);

export const CreateCandidateRaceRequestSchema = Type.Object(
  {
    baseWorkspaceVersionId: UuidSchema,
    prompt: Type.String({ minLength: 1, maxLength: 65_536 }),
    candidates: Type.Array(CandidateRaceCandidateInputSchema, {
      minItems: 2,
      maxItems: 4,
    }),
    maximumConcurrentCandidates: Type.Integer({ minimum: 1, maximum: 4 }),
    thinkingLevel: Type.Optional(TurnThinkingLevelSchema),
    acceptance: Type.Optional(
      Type.Object(
        {
          requirePatch: Type.Optional(Type.Boolean()),
          requireTests: Type.Optional(Type.Boolean()),
          maximumChangedPaths: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
          protectedPathPrefixes: Type.Optional(
            Type.Array(
              Type.String({
                minLength: 1,
                maxLength: 256,
                pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\u0000-\\u001f\\u007f\\\\]+$",
              }),
              { maxItems: 32, uniqueItems: true },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const CandidateRaceStateSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("cancel_requested"),
  Type.Literal("awaiting_decision"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

const CandidateRaceScorecardSchema = Type.Object(
  {
    reasons: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
    metrics: Type.Object(
      {
        runState: RunStateSchema,
        changedPaths: NonNegativeSafeIntegerSchema,
        tests: Type.Object(
          {
            total: NonNegativeSafeIntegerSchema,
            passed: NonNegativeSafeIntegerSchema,
            failed: NonNegativeSafeIntegerSchema,
            errored: NonNegativeSafeIntegerSchema,
          },
          { additionalProperties: false },
        ),
        modelRequests: NonNegativeSafeIntegerSchema,
        tokens: NonNegativeSafeIntegerSchema,
        costMicrousd: NonNegativeSafeIntegerSchema,
        durationMs: NonNegativeSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const CandidateRaceCandidateResourceSchema = Type.Object(
  {
    candidateId: UuidSchema,
    ordinal: PositiveSafeIntegerSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    strategy: Type.String({ minLength: 1, maxLength: 4_096 }),
    sessionId: UuidSchema,
    runId: UuidSchema,
    dispatchId: UuidSchema,
    dispatchGeneration: PositiveSafeIntegerSchema,
    dispatchState: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("running"),
      Type.Literal("settled"),
      Type.Literal("cancelled"),
    ]),
    runState: RunStateSchema,
    workspaceVersionId: Type.Optional(UuidSchema),
    acceptance: Type.Optional(
      Type.Object(
        {
          verdict: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
          reviewBundleId: Type.Optional(UuidSchema),
          evaluatedAt: UtcTimestampSchema,
          scorecard: CandidateRaceScorecardSchema,
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const CandidateRaceResourceSchema = Type.Object(
  {
    orchestrationId: UuidSchema,
    kind: Type.Literal("candidate_race"),
    state: CandidateRaceStateSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    parentSessionId: UuidSchema,
    baseWorkspaceVersionId: UuidSchema,
    prompt: Type.String({ minLength: 1, maxLength: 65_536 }),
    maximumConcurrentCandidates: PositiveSafeIntegerSchema,
    acceptancePolicy: CandidateRaceAcceptancePolicySchema,
    candidates: Type.Array(CandidateRaceCandidateResourceSchema, {
      minItems: 2,
      maxItems: 4,
    }),
    recommendedCandidateId: Type.Optional(UuidSchema),
    decisionGate: Type.Object(
      {
        gateId: UuidSchema,
        state: Type.Union([
          Type.Literal("pending"),
          Type.Literal("resolved"),
          Type.Literal("cancelled"),
        ]),
        selectedCandidateId: Type.Optional(UuidSchema),
        resolvedAt: Type.Optional(UtcTimestampSchema),
      },
      { additionalProperties: false },
    ),
    winnerCandidateId: Type.Optional(UuidSchema),
    promotedWorkspaceVersionId: Type.Optional(UuidSchema),
    cancelRequestedAt: Type.Optional(UtcTimestampSchema),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    settledAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const CandidateRaceListResourceSchema = Type.Object(
  {
    races: Type.Array(CandidateRaceResourceSchema, { maxItems: 50 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const PromoteCandidateRequestSchema = Type.Object(
  {
    candidateId: UuidSchema,
    expectedParentWorkspaceVersionId: UuidSchema,
  },
  { additionalProperties: false },
);

export const WorkspaceArtifactResourceSchema = Type.Object(
  {
    artifactId: UuidSchema,
    kind: Type.Union([
      Type.Literal("pi_session_snapshot"),
      Type.Literal("workspace_snapshot"),
      Type.Literal("tool_output"),
      Type.Literal("patch"),
      Type.Literal("report"),
      Type.Literal("crash_bundle"),
    ]),
    fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sizeBytes: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
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
    artifacts: Type.Array(WorkspaceArtifactResourceSchema, { maxItems: 3 }),
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

export const WorkspaceFileListResourceSchema = Type.Object(
  {
    versionId: UuidSchema,
    files: Type.Array(WorkspaceFileResourceSchema, { maxItems: 512 }),
  },
  { additionalProperties: false },
);

export const WorkspaceVersionCompareResourceSchema = Type.Object(
  {
    baseVersionId: UuidSchema,
    targetVersionId: UuidSchema,
    summary: Type.Object(
      {
        added: NonNegativeSafeIntegerSchema,
        modified: NonNegativeSafeIntegerSchema,
        deleted: NonNegativeSafeIntegerSchema,
        modeChanged: NonNegativeSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 512 }),
          change: Type.Union([
            Type.Literal("added"),
            Type.Literal("modified"),
            Type.Literal("deleted"),
            Type.Literal("mode_changed"),
          ]),
          baseSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
          targetSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1_024 },
    ),
  },
  { additionalProperties: false },
);

export const ForkSessionRequestSchema = Type.Object(
  { versionId: UuidSchema },
  { additionalProperties: false },
);

export const RollbackWorkspaceRequestSchema = Type.Object(
  {
    versionId: UuidSchema,
    expectedCurrentVersionId: UuidSchema,
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
    kind: Type.Union([
      Type.Literal("fork"),
      Type.Literal("rollback"),
      Type.Literal("archive"),
      Type.Literal("unarchive"),
    ]),
    sessionId: UuidSchema,
    versionId: Type.Optional(UuidSchema),
    forkedSessionId: Type.Optional(UuidSchema),
    replayed: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const GitHubInstallationResourceSchema = Type.Object(
  {
    installationId: PositiveSafeIntegerSchema,
    accountId: PositiveSafeIntegerSchema,
    accountLogin: Type.String({ minLength: 1, maxLength: 128 }),
    targetType: Type.Union([Type.Literal("User"), Type.Literal("Organization")]),
    repositorySelection: Type.Union([Type.Literal("all"), Type.Literal("selected")]),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("suspended"),
      Type.Literal("removed"),
    ]),
    repositories: Type.Array(
      Type.Object(
        {
          repositoryId: PositiveSafeIntegerSchema,
          fullName: Type.String({ minLength: 3, maxLength: 140 }),
          private: Type.Boolean(),
          defaultBranch: Type.String({ minLength: 1, maxLength: 255 }),
          enabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
  },
  { additionalProperties: false },
);

export const RegisterGitHubInstallationRequestSchema = Type.Object(
  { installationId: PositiveSafeIntegerSchema },
  { additionalProperties: false },
);

export const SetGitHubRepositoryRequestSchema = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);

export const CreateGitHubPullRequestRequestSchema = Type.Object(
  {
    repositoryId: PositiveSafeIntegerSchema,
    baseBranch: Type.String({ minLength: 1, maxLength: 255 }),
    baseCommitSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    headBranch: Type.String({ minLength: 1, maxLength: 255 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    body: Type.String({ maxLength: 16_384 }),
  },
  { additionalProperties: false },
);

export const GitHubPullRequestDeliveryResourceSchema = Type.Object(
  {
    deliveryId: UuidSchema,
    workspaceVersionId: UuidSchema,
    repositoryId: PositiveSafeIntegerSchema,
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("delivering"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ]),
    headBranch: Type.String({ minLength: 1, maxLength: 255 }),
    commitSha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
    pullRequestNumber: Type.Optional(PositiveSafeIntegerSchema),
    pullRequestUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    checkRunId: Type.Optional(PositiveSafeIntegerSchema),
    failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    replayed: Type.Boolean(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
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
export type ReplaceModelGovernanceRequest = Static<typeof ReplaceModelGovernanceRequestSchema>;
export type ModelGovernanceResource = Static<typeof ModelGovernanceResourceSchema>;
export type UsageSummaryResource = Static<typeof UsageSummaryResourceSchema>;
export type OperationalInsightsResource = Static<typeof OperationalInsightsResourceSchema>;
export type OperationalAuditEventResource = Static<typeof OperationalAuditEventResourceSchema>;
export type OperationalAuditLogResource = Static<typeof OperationalAuditLogResourceSchema>;
export type RunUsageResource = Static<typeof RunUsageResourceSchema>;
export type SessionContextResource = Static<typeof SessionContextResourceSchema>;
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
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type SessionResource = Static<typeof SessionResourceSchema>;
export type ConversationTurnState = Static<typeof ConversationTurnStateSchema>;
export type ConversationSummaryResource = Static<typeof ConversationSummaryResourceSchema>;
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
export type AcceptTurnRequest = Static<typeof AcceptTurnRequestSchema>;
export type AcceptedTurnResource = Static<typeof AcceptedTurnResourceSchema>;
export type RunState = Static<typeof RunStateSchema>;
export type RunAttemptState = Static<typeof RunAttemptStateSchema>;
export type RunAttemptTransitionResource = Static<typeof RunAttemptTransitionResourceSchema>;
export type RunAttemptResource = Static<typeof RunAttemptResourceSchema>;
export type RunResource = Static<typeof RunResourceSchema>;
export type RunListResource = Static<typeof RunListResourceSchema>;
export type TestResultResource = Static<typeof TestResultResourceSchema>;
export type TestResultListResource = Static<typeof TestResultListResourceSchema>;
export type CreateRunRewindRequest = Static<typeof CreateRunRewindRequestSchema>;
export type RunRewindResource = Static<typeof RunRewindResourceSchema>;
export type ReviewBundleManifest = Static<typeof ReviewBundleManifestSchema>;
export type ReviewBundleResource = Static<typeof ReviewBundleResourceSchema>;
export type CandidateRaceAcceptancePolicy = Static<typeof CandidateRaceAcceptancePolicySchema>;
export type CreateCandidateRaceRequest = Static<typeof CreateCandidateRaceRequestSchema>;
export type CandidateRaceState = Static<typeof CandidateRaceStateSchema>;
export type CandidateRaceResource = Static<typeof CandidateRaceResourceSchema>;
export type CandidateRaceListResource = Static<typeof CandidateRaceListResourceSchema>;
export type PromoteCandidateRequest = Static<typeof PromoteCandidateRequestSchema>;
export type WorkspaceArtifactResource = Static<typeof WorkspaceArtifactResourceSchema>;
export type WorkspaceVersionResource = Static<typeof WorkspaceVersionResourceSchema>;
export type WorkspaceVersionListResource = Static<typeof WorkspaceVersionListResourceSchema>;
export type WorkspaceFileResource = Static<typeof WorkspaceFileResourceSchema>;
export type WorkspaceFileListResource = Static<typeof WorkspaceFileListResourceSchema>;
export type WorkspaceVersionCompareResource = Static<typeof WorkspaceVersionCompareResourceSchema>;
export type ForkSessionRequest = Static<typeof ForkSessionRequestSchema>;
export type RollbackWorkspaceRequest = Static<typeof RollbackWorkspaceRequestSchema>;
export type ArchiveSessionRequest = Static<typeof ArchiveSessionRequestSchema>;
export type WorkspaceOperationResource = Static<typeof WorkspaceOperationResourceSchema>;
export type GitHubInstallationResource = Static<typeof GitHubInstallationResourceSchema>;
export type RegisterGitHubInstallationRequest = Static<
  typeof RegisterGitHubInstallationRequestSchema
>;
export type SetGitHubRepositoryRequest = Static<typeof SetGitHubRepositoryRequestSchema>;
export type CreateGitHubPullRequestRequest = Static<typeof CreateGitHubPullRequestRequestSchema>;
export type GitHubPullRequestDeliveryResource = Static<
  typeof GitHubPullRequestDeliveryResourceSchema
>;
export type CreateTurnCancellationRequest = Static<typeof CreateTurnCancellationRequestSchema>;
export type AcceptedTurnCancellationResource = Static<
  typeof AcceptedTurnCancellationResourceSchema
>;
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
  if (request.source === undefined || request.source.kind === "sample_java") {
    return { name, source: { kind: "sample_java" } };
  }
  if (request.source.kind === "empty") {
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

export function parseReplaceModelGovernanceRequest(value: unknown): ReplaceModelGovernanceRequest {
  const request = parseSchema(
    ReplaceModelGovernanceRequestSchema,
    value,
    "replace-model-governance request",
  );
  if (
    new Set(request.rates.map((rate) => `${rate.provider}/${rate.modelId}`)).size !==
    request.rates.length
  ) {
    throw new ControlPlaneApiValidationError("Model rates must have unique provider/model entries");
  }
  if (
    request.fallback.enabled &&
    (request.fallback.provider === undefined || request.fallback.modelId === undefined)
  ) {
    throw new ControlPlaneApiValidationError(
      "Enabled model fallback requires a provider and model",
    );
  }
  if (
    !request.fallback.enabled &&
    (request.fallback.provider !== undefined || request.fallback.modelId !== undefined)
  ) {
    throw new ControlPlaneApiValidationError("Disabled model fallback cannot name a model");
  }
  return request;
}

export function parseModelGovernanceResource(value: unknown): ModelGovernanceResource {
  return parseSchema(ModelGovernanceResourceSchema, value, "model-governance resource");
}

export function parseUsageSummaryResource(value: unknown): UsageSummaryResource {
  return parseSchema(UsageSummaryResourceSchema, value, "usage-summary resource");
}

export function parseOperationalInsightsResource(value: unknown): OperationalInsightsResource {
  return parseSchema(OperationalInsightsResourceSchema, value, "operational-insights resource");
}

export function parseOperationalAuditLogResource(value: unknown): OperationalAuditLogResource {
  return parseSchema(OperationalAuditLogResourceSchema, value, "operational-audit-log resource");
}

export function parseRunUsageResource(value: unknown): RunUsageResource {
  return parseSchema(RunUsageResourceSchema, value, "run-usage resource");
}

export function parseSessionContextResource(value: unknown): SessionContextResource {
  return parseSchema(SessionContextResourceSchema, value, "session-context resource");
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

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  return parseSchema(CreateSessionRequestSchema, value, "create-session request");
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

export function parseProjectResource(value: unknown): ProjectResource {
  return parseSchema(ProjectResourceSchema, value, "project resource");
}

export function parseSessionResource(value: unknown): SessionResource {
  return parseSchema(SessionResourceSchema, value, "session resource");
}

export function parseConversationListResource(value: unknown): ConversationListResource {
  return parseSchema(ConversationListResourceSchema, value, "conversation list resource");
}

export function parseConversationDetailResource(value: unknown): ConversationDetailResource {
  return parseSchema(ConversationDetailResourceSchema, value, "conversation detail resource");
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

export function parseCreateRunRewindRequest(value: unknown): CreateRunRewindRequest {
  return parseSchema(CreateRunRewindRequestSchema, value, "create-run-rewind request");
}

export function parseRunRewindResource(value: unknown): RunRewindResource {
  return parseSchema(RunRewindResourceSchema, value, "run-rewind resource");
}

export function parseReviewBundleManifest(value: unknown): ReviewBundleManifest {
  return parseSchema(ReviewBundleManifestSchema, value, "review-bundle manifest");
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

export function canonicalReviewBundleManifestJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(parseReviewBundleManifest(value)));
}

export function parseReviewBundleResource(value: unknown): ReviewBundleResource {
  return parseSchema(ReviewBundleResourceSchema, value, "review-bundle resource");
}

export function parseCreateCandidateRaceRequest(value: unknown): CreateCandidateRaceRequest {
  const request = parseSchema(
    CreateCandidateRaceRequestSchema,
    value,
    "create-candidate-race request",
  );
  if (request.prompt.trim().length === 0) {
    throw new ControlPlaneApiValidationError(
      "Candidate-race prompt must contain a non-whitespace character",
    );
  }
  if (request.maximumConcurrentCandidates > request.candidates.length) {
    throw new ControlPlaneApiValidationError(
      "maximumConcurrentCandidates cannot exceed the candidate count",
    );
  }
  const labels = new Set<string>();
  for (const candidate of request.candidates) {
    const label = candidate.label.trim();
    if (label.length === 0 || candidate.strategy.trim().length === 0) {
      throw new ControlPlaneApiValidationError(
        "Candidate labels and strategies must contain non-whitespace characters",
      );
    }
    const identity = label.toLocaleLowerCase();
    if (labels.has(identity)) {
      throw new ControlPlaneApiValidationError("Candidate labels must be unique");
    }
    labels.add(identity);
  }
  return request;
}

export function parseCandidateRaceAcceptancePolicy(value: unknown): CandidateRaceAcceptancePolicy {
  return parseSchema(
    CandidateRaceAcceptancePolicySchema,
    value,
    "candidate-race acceptance policy",
  );
}

export function parseCandidateRaceResource(value: unknown): CandidateRaceResource {
  return parseSchema(CandidateRaceResourceSchema, value, "candidate-race resource");
}

export function parseCandidateRaceListResource(value: unknown): CandidateRaceListResource {
  return parseSchema(CandidateRaceListResourceSchema, value, "candidate-race-list resource");
}

export function parsePromoteCandidateRequest(value: unknown): PromoteCandidateRequest {
  return parseSchema(PromoteCandidateRequestSchema, value, "promote-candidate request");
}

export function parseTestResultListResource(value: unknown): TestResultListResource {
  return parseSchema(TestResultListResourceSchema, value, "test-result-list resource");
}

export function parseForkSessionRequest(value: unknown): ForkSessionRequest {
  return parseSchema(ForkSessionRequestSchema, value, "fork-session request");
}

export function parseRollbackWorkspaceRequest(value: unknown): RollbackWorkspaceRequest {
  return parseSchema(RollbackWorkspaceRequestSchema, value, "rollback-workspace request");
}

export function parseArchiveSessionRequest(value: unknown): ArchiveSessionRequest {
  return parseSchema(ArchiveSessionRequestSchema, value, "archive-session request");
}

export function parseRegisterGitHubInstallationRequest(
  value: unknown,
): RegisterGitHubInstallationRequest {
  return parseSchema(
    RegisterGitHubInstallationRequestSchema,
    value,
    "register-GitHub-installation request",
  );
}

export function parseSetGitHubRepositoryRequest(value: unknown): SetGitHubRepositoryRequest {
  return parseSchema(SetGitHubRepositoryRequestSchema, value, "set-GitHub-repository request");
}

export function parseCreateGitHubPullRequestRequest(
  value: unknown,
): CreateGitHubPullRequestRequest {
  const request = parseSchema(
    CreateGitHubPullRequestRequestSchema,
    value,
    "create-GitHub-pull-request request",
  );
  if (
    request.baseBranch.startsWith("/") ||
    request.headBranch.startsWith("/") ||
    request.baseBranch.includes("..") ||
    request.headBranch.includes("..") ||
    /[~^:?*[\\\u0000-\u0020\u007f]/.test(request.baseBranch) ||
    /[~^:?*[\\\u0000-\u0020\u007f]/.test(request.headBranch)
  ) {
    throw new ControlPlaneApiValidationError("GitHub branch name is invalid");
  }
  return request;
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

export function parseWorkspaceVersionCompareResource(
  value: unknown,
): WorkspaceVersionCompareResource {
  return parseSchema(
    WorkspaceVersionCompareResourceSchema,
    value,
    "workspace-version-compare resource",
  );
}

export function parseWorkspaceOperationResource(value: unknown): WorkspaceOperationResource {
  return parseSchema(WorkspaceOperationResourceSchema, value, "workspace-operation resource");
}

export function parseGitHubInstallationResource(value: unknown): GitHubInstallationResource {
  return parseSchema(GitHubInstallationResourceSchema, value, "GitHub-installation resource");
}

export function parseGitHubPullRequestDeliveryResource(
  value: unknown,
): GitHubPullRequestDeliveryResource {
  return parseSchema(
    GitHubPullRequestDeliveryResourceSchema,
    value,
    "GitHub-pull-request-delivery resource",
  );
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
