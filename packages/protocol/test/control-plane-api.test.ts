import { describe, expect, it } from "vitest";
import {
  canonicalWorkspaceSourceSetJson,
  ControlPlaneApiValidationError,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  parseAcceptTurnRequest,
  parseAcceptedTurnCancellationResource,
  parseAcceptedTurnResource,
  parseConversationDetailResource,
  parseConversationListResource,
  parseControlPlaneApiError,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseCreateTenantRegistrationRequest,
  parseCreateDevelopmentEnvironmentRequest,
  parseDevelopmentEnvironmentActionRequest,
  parseDevelopmentEnvironmentListResource,
  parseCreateTurnCancellationRequest,
  parseIdempotencyKey,
  parseLastEventIdHeader,
  parseLiveTurnSnapshotResource,
  parseModelConfigurationResource,
  parseProjectResource,
  parseReplaceModelConfigurationRequest,
  parseRunResource,
  parseSessionResource,
  parseTenantIdentityResource,
  parseTenantRegistrationResource,
  parseUuidPathParameter,
  parseWorkspaceSourceSetSnapshot,
} from "../src/index.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_SNAPSHOT = {
  environmentVersionId: "90000000-0000-4000-8000-000000000001",
  versionNumber: 1,
  profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  imageRevision: "sha-0123456789abcdef",
  specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} as const;

describe("control-plane public API schemas", () => {
  it("validates user-owned development environment resources and actions", () => {
    const createdAt = "2026-08-20T00:00:00.000Z";
    expect(parseCreateDevelopmentEnvironmentRequest({ workspaceId: UUID })).toEqual({
      workspaceId: UUID,
    });
    expect(parseDevelopmentEnvironmentActionRequest({ action: "pause" })).toEqual({
      action: "pause",
    });
    expect(
      parseDevelopmentEnvironmentListResource({
        environments: [
          {
            environmentId: UUID,
            projectId: "22222222-2222-4222-8222-222222222222",
            workspaceId: "33333333-3333-4333-8333-333333333333",
            workspaceName: "agent-runtime",
            state: "running",
            generation: 1,
            createdAt,
            updatedAt: createdAt,
          },
        ],
        truncated: false,
      }),
    ).toMatchObject({ environments: [{ state: "running" }] });
    expect(() => parseDevelopmentEnvironmentActionRequest({ action: "reimage" })).toThrow();
  });

  it("validates an active Turn catch-up snapshot", () => {
    expect(
      parseLiveTurnSnapshotResource({
        sessionId: "30000000-0000-4000-8000-000000000001",
        replayAfterSequence: 2,
        turn: {
          turnId: "50000000-0000-4000-8000-000000000001",
          transcript: {
            schemaVersion: 1,
            throughSequence: 2,
            items: [
              {
                kind: "text",
                text: "still running",
                firstSequence: 1,
                lastSequence: 2,
              },
            ],
            startedSequence: null,
            terminalSequence: null,
            stopReason: null,
            failure: null,
            cancellation: null,
            workspacePatch: null,
          },
        },
      }),
    ).toMatchObject({ replayAfterSequence: 2, turn: { transcript: { throughSequence: 2 } } });
  });

  it("validates public resources before a browser consumes them", () => {
    const createdAt = "2026-07-19T00:00:00.000Z";
    expect(
      parseProjectResource({
        projectId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "20000000-0000-4000-8000-000000000001",
        name: "Java repair demo",
        createdAt,
        source: { kind: "sample_java", status: "ready" },
        environment: {
          ...ENVIRONMENT_SNAPSHOT,
          state: "pending",
          active: true,
          createdAt,
        },
      }),
    ).toMatchObject({ name: "Java repair demo" });
    expect(
      parseSessionResource({
        sessionId: "30000000-0000-4000-8000-000000000001",
        title: "Repair Java demo",
        projectId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "20000000-0000-4000-8000-000000000001",
        state: "cold",
        sandboxRetention: "persistent",
        modelProfileId: "40000000-0000-4000-8000-000000000001",
        createdAt,
      }),
    ).toMatchObject({ state: "cold" });
    expect(
      parseAcceptedTurnResource({
        runId: "50000000-0000-4000-8000-000000000010",
        turnId: "50000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        commandId: "60000000-0000-4000-8000-000000000001",
        mailboxPosition: 1,
        state: "queued",
        acceptedAt: createdAt,
        replayed: false,
      }),
    ).toMatchObject({ state: "queued" });
    expect(
      parseAcceptedTurnCancellationResource({
        commandId: "70000000-0000-4000-8000-000000000001",
        targetCommandId: "60000000-0000-4000-8000-000000000001",
        turnId: "50000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        state: "pending",
        acceptedAt: createdAt,
        replayed: false,
      }),
    ).toMatchObject({ state: "pending" });
    expect(
      parseControlPlaneApiError({
        error: { code: "conflict", message: "Session already has an active turn" },
      }),
    ).toMatchObject({ error: { code: "conflict" } });
    expect(
      parseTenantIdentityResource({
        tenantId: "80000000-0000-4000-8000-000000000001",
        tenantSlug: "private-alpha",
        userId: "80000000-0000-4000-8000-000000000002",
        displayName: "Alpha Operator",
        role: "member",
        platformAdministrator: false,
      }),
    ).toMatchObject({ tenantSlug: "private-alpha", role: "member" });
    expect(
      parseTenantRegistrationResource({
        tenantId: "80000000-0000-4000-8000-000000000001",
        tenantSlug: "public-alpha",
        userId: "80000000-0000-4000-8000-000000000002",
        displayName: "Alpha Owner",
        role: "owner",
        apiToken: `pck_80000000-0000-4000-8000-000000000003.${"a".repeat(43)}`,
      }),
    ).toMatchObject({ tenantSlug: "public-alpha", role: "owner" });
    expect(
      parseConversationListResource({
        conversations: [
          {
            sessionId: "30000000-0000-4000-8000-000000000001",
            title: "Repair checkout",
            projectId: "10000000-0000-4000-8000-000000000001",
            workspaceId: "20000000-0000-4000-8000-000000000001",
            workspaceName: "Java repair demo",
            state: "idle",
            sandboxRetention: "ephemeral",
            turnCount: 1,
            createdAt,
            updatedAt: createdAt,
            lastActiveAt: createdAt,
          },
        ],
        delegatedSessions: [],
        truncated: false,
      }),
    ).toMatchObject({ conversations: [{ title: "Repair checkout" }] });
    expect(
      parseConversationDetailResource({
        project: {
          projectId: "10000000-0000-4000-8000-000000000001",
          workspaceId: "20000000-0000-4000-8000-000000000001",
          name: "Java repair demo",
          createdAt,
          source: { kind: "sample_java", status: "ready" },
          environment: {
            ...ENVIRONMENT_SNAPSHOT,
            state: "pending",
            active: true,
            createdAt,
          },
        },
        session: {
          sessionId: "30000000-0000-4000-8000-000000000001",
          title: "Repair checkout",
          projectId: "10000000-0000-4000-8000-000000000001",
          workspaceId: "20000000-0000-4000-8000-000000000001",
          state: "running",
          sandboxRetention: "persistent",
          modelProfileId: "40000000-0000-4000-8000-000000000001",
          createdAt,
          updatedAt: createdAt,
          lastActiveAt: createdAt,
        },
        inheritedMessages: [],
        turns: [
          {
            runId: "50000000-0000-4000-8000-000000000010",
            turnId: "50000000-0000-4000-8000-000000000001",
            commandId: "60000000-0000-4000-8000-000000000001",
            mailboxPosition: 1,
            prompt: "repair it",
            state: "running",
            transcript: {
              schemaVersion: 1,
              throughSequence: 4,
              items: [
                {
                  kind: "text",
                  text: "Working on it.",
                  firstSequence: 2,
                  lastSequence: 3,
                },
              ],
              startedSequence: 1,
              terminalSequence: 4,
              stopReason: "stop",
              failure: null,
              cancellation: null,
              workspacePatch: null,
            },
            acceptedAt: createdAt,
          },
        ],
        historyTruncated: false,
        replayAfterSequence: 0,
      }),
    ).toMatchObject({
      turns: [
        {
          prompt: "repair it",
          transcript: { throughSequence: 4, items: [{ text: "Working on it." }] },
        },
      ],
    });

    expect(
      parseRunResource({
        runId: "50000000-0000-4000-8000-000000000010",
        traceId: "11111111111111111111111111111111",
        projectId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "20000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        turnId: "50000000-0000-4000-8000-000000000001",
        commandId: "60000000-0000-4000-8000-000000000001",
        state: "running",
        environment: ENVIRONMENT_SNAPSHOT,
        sourceSet: {
          schemaVersion: 1,
          entries: [{ root: ".", kind: "sample_java" }],
        },
        attemptCount: 1,
        currentAttemptId: "50000000-0000-4000-8000-000000000011",
        queuedAt: createdAt,
        startedAt: createdAt,
        updatedAt: createdAt,
        attempts: [
          {
            attemptId: "50000000-0000-4000-8000-000000000011",
            attemptNumber: 1,
            state: "running",
            projection: "canonical",
            claimOwnerId: "control-plane-1",
            claimExpiresAt: "2026-07-19T00:01:00.000Z",
            sandboxId: "50000000-0000-4000-8000-000000000012",
            leaseId: "50000000-0000-4000-8000-000000000013",
            fencingToken: 1,
            claimedAt: createdAt,
            provisioningAt: createdAt,
            runningAt: createdAt,
            lastHeartbeatAt: createdAt,
            transitions: [
              {
                fromState: null,
                toState: "claimed",
                reason: "outbox_claim",
                occurredAt: createdAt,
              },
              {
                fromState: "claimed",
                toState: "provisioning",
                reason: "command_acknowledged",
                occurredAt: createdAt,
              },
              {
                fromState: "provisioning",
                toState: "running",
                reason: "pi_started",
                occurredAt: createdAt,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ state: "running", attempts: [{ attemptNumber: 1 }] });
  });

  it("rejects malformed public resources", () => {
    expect(() =>
      parseAcceptedTurnResource({
        turnId: "not-a-uuid",
        state: "running",
      }),
    ).toThrow(/accepted-turn resource/);
    expect(() =>
      parseAcceptedTurnResource({
        runId: "50000000-0000-4000-8000-000000000010",
        turnId: "50000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        commandId: "60000000-0000-4000-8000-000000000001",
        mailboxPosition: 0,
        state: "queued",
        acceptedAt: "2026-07-19T00:00:00.000Z",
        replayed: false,
      }),
    ).toThrow(/accepted-turn resource/);
    expect(() => parseControlPlaneApiError({ error: { message: "missing code" } })).toThrow(
      /control-plane API error/,
    );
    expect(() =>
      parseTenantIdentityResource({
        tenantId: "80000000-0000-4000-8000-000000000001",
        tenantSlug: "private-alpha",
        userId: "80000000-0000-4000-8000-000000000002",
        displayName: "Alpha Operator",
        role: "admin",
        secretSha256: "must-never-cross-the-API",
      }),
    ).toThrow(/tenant identity resource/);
  });

  it("normalizes project names and preserves prompt text", () => {
    expect(parseCreateProjectRequest({ name: "  PiCloud  " })).toEqual({
      name: "PiCloud",
      source: { kind: "empty" },
    });
    expect(
      parseCreateProjectRequest({
        name: "Imported repository",
        source: {
          kind: "github_public",
          repository: "octocat/hello-world",
          commitSha: "a".repeat(40),
        },
      }),
    ).toEqual({
      name: "Imported repository",
      source: {
        kind: "github_public",
        repository: "octocat/hello-world",
        commitSha: "a".repeat(40),
      },
    });
    expect(parseAcceptTurnRequest({ prompt: "  fix the test  ", thinkingLevel: "low" })).toEqual({
      prompt: "  fix the test  ",
      thinkingLevel: "low",
    });
    expect(
      parseCreateTenantRegistrationRequest({
        tenantSlug: "  Team-Alpha  ",
        displayName: "  Alpha Owner  ",
      }),
    ).toEqual({ tenantSlug: "team-alpha", displayName: "Alpha Owner" });
  });

  it("normalizes immutable multi-repository sources and rejects overlapping identities", () => {
    const sourceSet = parseCreateProjectRequest({
      name: "  Full stack  ",
      source: {
        kind: "repository_set",
        repositories: [
          {
            root: "web",
            kind: "github_public",
            repository: "octocat/frontend",
            commitSha: "a".repeat(40),
          },
          {
            root: "api",
            kind: "github_app",
            installationId: 17,
            repositoryId: 29,
            commitSha: "b".repeat(40),
          },
        ],
      },
    });
    expect(sourceSet).toMatchObject({
      name: "Full stack",
      source: {
        kind: "repository_set",
        repositories: [{ root: "web" }, { root: "api" }],
      },
    });

    const snapshot = parseWorkspaceSourceSetSnapshot({
      schemaVersion: 1,
      entries: [
        {
          root: "web",
          kind: "github_public",
          repository: "octocat/frontend",
          commitSha: "a".repeat(40),
        },
        {
          root: "api",
          kind: "github_app",
          installationId: 17,
          repositoryId: 29,
          repository: "octocat/backend",
          commitSha: "b".repeat(40),
          private: true,
        },
      ],
    });
    expect(snapshot.entries.map((entry) => entry.root)).toEqual(["api", "web"]);
    expect(canonicalWorkspaceSourceSetJson(snapshot)).toContain('"root":"api"');

    for (const repositories of [
      [
        {
          root: "web",
          kind: "github_public",
          repository: "octocat/frontend",
          commitSha: "a".repeat(40),
        },
        {
          root: "web",
          kind: "github_public",
          repository: "octocat/backend",
          commitSha: "b".repeat(40),
        },
      ],
      [
        {
          root: "web",
          kind: "github_public",
          repository: "octocat/frontend",
          commitSha: "a".repeat(40),
        },
        {
          root: "api",
          kind: "github_public",
          repository: "octocat/frontend",
          commitSha: "b".repeat(40),
        },
      ],
      [
        {
          root: "web",
          kind: "github_public",
          repository: "octocat/frontend.git",
          commitSha: "a".repeat(40),
        },
        {
          root: "api",
          kind: "github_public",
          repository: "octocat/backend",
          commitSha: "b".repeat(40),
        },
      ],
    ]) {
      expect(() =>
        parseCreateProjectRequest({
          name: "invalid set",
          source: { kind: "repository_set", repositories },
        }),
      ).toThrow(ControlPlaneApiValidationError);
    }
  });

  it("keeps tenant model configuration closed and secret-free on reads", () => {
    expect(
      parseReplaceModelConfigurationRequest({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: `sk-${"a".repeat(48)}`,
      }),
    ).toMatchObject({ provider: "deepseek", modelId: "deepseek-v4-flash" });
    expect(
      parseModelConfigurationResource({
        mode: "real",
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        configured: true,
        credentialVersion: 2,
        updatedAt: "2026-07-19T00:00:00.000Z",
      }),
    ).toMatchObject({ mode: "real", credentialVersion: 2 });
    expect(() =>
      parseReplaceModelConfigurationRequest({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: `sk-${"a".repeat(48)}`,
        baseUrl: "https://attacker.invalid",
      }),
    ).toThrow(ControlPlaneApiValidationError);
    expect(() =>
      parseModelConfigurationResource({
        mode: "real",
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        configured: true,
        credentialVersion: 2,
        updatedAt: "2026-07-19T00:00:00.000Z",
        apiKey: "must-not-cross",
      }),
    ).toThrow(ControlPlaneApiValidationError);
  });

  it("validates workspace and path identities as UUIDs", () => {
    expect(parseCreateSessionRequest({ workspaceId: UUID, title: "  Fix checkout  " })).toEqual({
      workspaceId: UUID,
      title: "Fix checkout",
      sandboxRetention: "ephemeral",
    });
    expect(parseUuidPathParameter(UUID, "sessionId")).toBe(UUID);
    expect(() => parseUuidPathParameter("session-1", "sessionId")).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("accepts only normalized public GitHub coordinates pinned to an exact commit", () => {
    const invalidSources = [
      {
        kind: "github_public",
        repository: "https://github.com/octocat/hello-world",
        commitSha: "a".repeat(40),
      },
      { kind: "github_public", repository: "Octocat/hello-world", commitSha: "a".repeat(40) },
      { kind: "github_public", repository: "octocat/../secret", commitSha: "a".repeat(40) },
      { kind: "github_public", repository: "octocat/hello-world.git", commitSha: "a".repeat(40) },
      { kind: "github_public", repository: "octocat/hello-world", commitSha: "main" },
      { kind: "github_public", repository: "octocat/hello-world", commitSha: "A".repeat(40) },
      {
        kind: "github_public",
        repository: "octocat/hello-world",
        commitSha: "a".repeat(40),
        token: "must-not-cross",
      },
    ];
    for (const source of invalidSources) {
      expect(() => parseCreateProjectRequest({ name: "invalid", source })).toThrow(
        ControlPlaneApiValidationError,
      );
    }
  });

  it("rejects whitespace-only values, extra fields, and unsupported thinking levels", () => {
    expect(() => parseCreateProjectRequest({ name: "   " })).toThrow(
      "Project name must contain a non-whitespace character",
    );
    expect(() => parseAcceptTurnRequest({ prompt: "\n\t" })).toThrow(
      "Turn prompt must contain a non-whitespace character",
    );
    expect(() => parseAcceptTurnRequest({ prompt: "hello", rawProvider: "secret" })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() => parseAcceptTurnRequest({ prompt: "hello", thinkingLevel: "turbo" })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() =>
      parseCreateTenantRegistrationRequest({ tenantSlug: "bad slug", displayName: "Owner" }),
    ).toThrow(ControlPlaneApiValidationError);
    expect(() =>
      parseCreateTenantRegistrationRequest({
        tenantSlug: "valid-slug",
        displayName: "x".repeat(257),
      }),
    ).toThrow(ControlPlaneApiValidationError);
  });

  it("accepts portable idempotency keys and rejects ambiguous header values", () => {
    expect(parseIdempotencyKey("request-01:retry.2")).toBe("request-01:retry.2");
    expect(() => parseIdempotencyKey(undefined)).toThrow(ControlPlaneApiValidationError);
    expect(() => parseIdempotencyKey(["one", "two"])).toThrow(ControlPlaneApiValidationError);
    expect(() => parseIdempotencyKey("contains whitespace")).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("accepts a bounded cancellation grace period and rejects extra fields", () => {
    expect(parseCreateTurnCancellationRequest({})).toEqual({});
    expect(parseCreateTurnCancellationRequest({ gracePeriodMs: 2_000 })).toEqual({
      gracePeriodMs: 2_000,
    });
    expect(() => parseCreateTurnCancellationRequest({ gracePeriodMs: -1 })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() => parseCreateTurnCancellationRequest({ gracePeriodMs: 30_001 })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() => parseCreateTurnCancellationRequest({ reason: "shutdown" })).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("parses canonical resumable SSE cursors", () => {
    expect(parseLastEventIdHeader(undefined)).toBe(0);
    expect(parseLastEventIdHeader("0")).toBe(0);
    expect(parseLastEventIdHeader("42")).toBe(42);
    for (const invalid of ["", "01", "-1", "+1", " 1", ["1", "2"], 1]) {
      expect(() => parseLastEventIdHeader(invalid)).toThrow(ControlPlaneApiValidationError);
    }
    expect(() => parseLastEventIdHeader(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(
      "outside the supported integer range",
    );
  });
});
