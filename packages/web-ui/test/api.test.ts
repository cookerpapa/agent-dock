import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@agent-dock/protocol";

import { AgentDockApi } from "../src/api.ts";

const environment = {
  environmentVersionId: "90000000-0000-4000-8000-000000000001",
  versionNumber: 1,
  profileKey: "agent-dock-fullstack",
  profileVersion: "1",
  imageRevision: "sha-0123456789abcdef",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  state: "pending",
  active: true,
  createdAt: "2026-07-19T00:00:00.000Z",
} as const;

describe("tenant-aware browser API", () => {
  it("uses same-origin cookie sessions for product registration, login, and logout", async () => {
    const identity = {
      tenantId: "10000000-0000-4000-8000-000000000002",
      tenantSlug: "u-alice-12345678",
      userId: "10000000-0000-4000-8000-000000000003",
      displayName: "Alice",
      role: "owner" as const,
      platformAdministrator: false,
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.credentials).toBe("same-origin");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      const path = String(input);
      if (path === "/v1/auth/logout") {
        return new Response(JSON.stringify({ loggedOut: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ identity, expiresAt: "2026-08-19T00:00:00.000Z" }), {
        status: path.endsWith("register") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    const api = new AgentDockApi(fetchImplementation);
    await expect(api.registerAccount("alice", "Alice", "long password 123")).resolves.toMatchObject(
      { identity },
    );
    await expect(api.loginAccount("alice", "long password 123")).resolves.toMatchObject({
      identity,
    });
    await expect(api.logout()).resolves.toEqual({ loggedOut: true });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("creates a project from a normalized exact-commit GitHub source", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const commitSha = "b".repeat(40);
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("/v1/projects");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "Pinned repository",
        source: {
          kind: "github_public",
          repository: "octocat/hello-world",
          commitSha,
        },
      });
      return new Response(
        JSON.stringify({
          projectId: "20000000-0000-4000-8000-000000000001",
          workspaceId: "30000000-0000-4000-8000-000000000001",
          name: "Pinned repository",
          createdAt: "2026-07-19T00:00:00.000Z",
          environment,
          source: {
            kind: "github_public",
            repository: "octocat/hello-world",
            commitSha,
            status: "pending",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);
    await expect(
      api.createProject("Pinned repository", {
        kind: "github_public",
        repository: "octocat/hello-world",
        commitSha,
      }),
    ).resolves.toMatchObject({ source: { kind: "github_public", status: "pending" } });
  });

  it("manages environment candidates through versioned, idempotent APIs", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const projectId = "20000000-0000-4000-8000-000000000001";
    const sessionId = "30000000-0000-4000-8000-000000000001";
    const history = {
      projectId,
      activeEnvironmentVersionId: environment.environmentVersionId,
      versions: [environment],
      operations: [],
      truncated: false,
    };
    const accepted = {
      turnId: "40000000-0000-4000-8000-000000000001",
      sessionId,
      runId: "50000000-0000-4000-8000-000000000001",
      commandId: "60000000-0000-4000-8000-000000000001",
      mailboxPosition: 1,
      state: "queued",
      acceptedAt: "2026-07-19T00:00:00.000Z",
      replayed: false,
    } as const;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      if (init === undefined) throw new Error("Expected request options");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const path = String(input);
      if (path.includes(`/v1/sessions/${sessionId}/environments/`)) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("idempotency-key")).toBe("validate-environment");
        return new Response(JSON.stringify(accepted), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.endsWith("/activate")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedActiveEnvironmentVersionId: environment.environmentVersionId,
        });
        expect(new Headers(init?.headers).get("idempotency-key")).toBe("activate-environment");
      } else if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        });
        expect(new Headers(init.headers).get("idempotency-key")).toBe("create-environment");
      }
      return new Response(JSON.stringify(history), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const api = new AgentDockApi(fetchImplementation, token);
    await expect(api.getProjectEnvironments(projectId)).resolves.toEqual(history);
    await expect(
      api.createProjectEnvironment(
        projectId,
        DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        "create-environment",
      ),
    ).resolves.toEqual(history);
    await expect(
      api.activateProjectEnvironment(
        projectId,
        environment.environmentVersionId,
        environment.environmentVersionId,
        "activate-environment",
      ),
    ).resolves.toEqual(history);
    await expect(
      api.validateProjectEnvironment(
        sessionId,
        environment.environmentVersionId,
        "validate-environment",
      ),
    ).resolves.toEqual(accepted);
  });

  it("creates and promotes a bounded candidate race through idempotent APIs", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const sessionId = "31000000-0000-4000-8000-000000000001";
    const orchestrationId = "32000000-0000-4000-8000-000000000001";
    const baseWorkspaceVersionId = "33000000-0000-4000-8000-000000000001";
    const firstCandidateId = "34000000-0000-4000-8000-000000000001";
    const createBody = {
      baseWorkspaceVersionId,
      prompt: "Repair the failing tests.",
      candidates: [
        { label: "Minimal", strategy: "Prefer the smallest safe patch." },
        { label: "Robust", strategy: "Prefer explicit validation and regression tests." },
      ],
      maximumConcurrentCandidates: 2,
      acceptance: {
        requirePatch: true,
        requireTests: true,
        maximumChangedPaths: 12,
        protectedPathPrefixes: [".github/"],
      },
    };
    const race = {
      orchestrationId,
      kind: "candidate_race",
      state: "running",
      projectId: "35000000-0000-4000-8000-000000000001",
      workspaceId: "36000000-0000-4000-8000-000000000001",
      parentSessionId: sessionId,
      baseWorkspaceVersionId,
      prompt: createBody.prompt,
      maximumConcurrentCandidates: 2,
      acceptancePolicy: createBody.acceptance,
      candidates: [
        {
          candidateId: firstCandidateId,
          ordinal: 1,
          label: "Minimal",
          strategy: "Prefer the smallest safe patch.",
          sessionId: "37000000-0000-4000-8000-000000000001",
          runId: "38000000-0000-4000-8000-000000000001",
          dispatchId: "39000000-0000-4000-8000-000000000001",
          dispatchGeneration: 1,
          dispatchState: "accepted",
          runState: "queued",
          createdAt: "2026-07-23T00:00:00.000Z",
        },
        {
          candidateId: "34000000-0000-4000-8000-000000000002",
          ordinal: 2,
          label: "Robust",
          strategy: "Prefer explicit validation and regression tests.",
          sessionId: "37000000-0000-4000-8000-000000000002",
          runId: "38000000-0000-4000-8000-000000000002",
          dispatchId: "39000000-0000-4000-8000-000000000002",
          dispatchGeneration: 1,
          dispatchState: "accepted",
          runState: "queued",
          createdAt: "2026-07-23T00:00:00.000Z",
        },
      ],
      decisionGate: {
        gateId: "3a000000-0000-4000-8000-000000000001",
        state: "pending",
      },
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    } as const;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      if (init === undefined) throw new Error("Expected candidate-race request options");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const path = String(input);
      if (path.endsWith("/promotion")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init.headers).get("idempotency-key")).toBe("promote-race");
        expect(JSON.parse(String(init.body))).toEqual({
          candidateId: firstCandidateId,
          expectedParentWorkspaceVersionId: baseWorkspaceVersionId,
        });
      } else {
        expect(path).toBe(`/v1/sessions/${sessionId}/candidate-races`);
        expect(init?.method).toBe("POST");
        expect(new Headers(init.headers).get("idempotency-key")).toBe("create-race");
        expect(JSON.parse(String(init.body))).toEqual(createBody);
      }
      return new Response(JSON.stringify(race), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const api = new AgentDockApi(fetchImplementation, token);
    await expect(api.createCandidateRace(sessionId, createBody, "create-race")).resolves.toEqual(
      race,
    );
    await expect(
      api.promoteCandidate(
        orchestrationId,
        firstCandidateId,
        baseWorkspaceVersionId,
        "promote-race",
      ),
    ).resolves.toEqual(race);
  });

  it("reads safe model metadata and submits a write-only provider credential", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const providerKey = `sk-${"p".repeat(48)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            mode: "deterministic",
            provider: "agent-dock-fake",
            modelId: "agent-dock-fake",
            configured: false,
            credentialVersion: 1,
            updatedAt: "2026-07-19T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(String(input)).toBe("/v1/model-configuration");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: providerKey,
      });
      return new Response(
        JSON.stringify({
          mode: "real",
          provider: "deepseek",
          modelId: "deepseek-v4-flash",
          configured: true,
          credentialVersion: 2,
          updatedAt: "2026-07-19T00:01:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);
    await expect(api.getModelConfiguration()).resolves.toMatchObject({
      mode: "deterministic",
    });
    await expect(
      api.replaceModelConfiguration("deepseek-v4-flash", providerKey),
    ).resolves.toMatchObject({ mode: "real", credentialVersion: 2 });
  });

  it("reads and hot-replaces the versioned Cube proxy origin", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(String(input)).toBe("/v1/platform-settings/cube-proxy");
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            enabled: false,
            configured: false,
            revision: 0,
            updatedAt: "2026-07-26T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        enabled: true,
        proxyUrl: "http://127.0.0.1:7890",
      });
      return new Response(
        JSON.stringify({
          enabled: true,
          configured: true,
          proxyUrl: "http://127.0.0.1:7890",
          revision: 1,
          updatedAt: "2026-07-26T00:01:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);
    await expect(api.getCubeProxyConfiguration()).resolves.toMatchObject({
      enabled: false,
      revision: 0,
    });
    await expect(
      api.replaceCubeProxyConfiguration(true, "http://127.0.0.1:7890"),
    ).resolves.toMatchObject({ enabled: true, revision: 1 });
  });

  it("authenticates identity before exposing tenant metadata", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return new Response(
        JSON.stringify({
          tenantId: "10000000-0000-4000-8000-000000000002",
          tenantSlug: "private-alpha",
          userId: "10000000-0000-4000-8000-000000000003",
          displayName: "Alpha Operator",
          role: "viewer",
          platformAdministrator: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);

    await expect(api.getIdentity()).resolves.toEqual({
      tenantId: "10000000-0000-4000-8000-000000000002",
      tenantSlug: "private-alpha",
      userId: "10000000-0000-4000-8000-000000000003",
      displayName: "Alpha Operator",
      role: "viewer",
      platformAdministrator: false,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/v1/identity",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("registers without a bearer and validates the one-time owner credential", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({
        tenantSlug: "team-alpha",
        displayName: "Alpha Owner",
      });
      return new Response(
        JSON.stringify({
          tenantId: "10000000-0000-4000-8000-000000000002",
          tenantSlug: "team-alpha",
          userId: "10000000-0000-4000-8000-000000000003",
          displayName: "Alpha Owner",
          role: "owner",
          apiToken: token,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation);

    await expect(api.registerTenant("team-alpha", "Alpha Owner")).resolves.toMatchObject({
      tenantSlug: "team-alpha",
      role: "owner",
      apiToken: token,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/v1/registrations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("loads only authenticated conversation resources", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const createdAt = "2026-07-19T00:00:00.000Z";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const path = String(input);
      return new Response(
        JSON.stringify(
          path === "/v1/conversations"
            ? {
                conversations: [
                  {
                    sessionId: "20000000-0000-4000-8000-000000000001",
                    projectId: "30000000-0000-4000-8000-000000000001",
                    workspaceId: "40000000-0000-4000-8000-000000000001",
                    title: "Repair checkout",
                    workspaceName: "Alpha repair",
                    state: "idle",
                    turnCount: 1,
                    createdAt,
                    updatedAt: createdAt,
                    lastActiveAt: createdAt,
                  },
                ],
                truncated: false,
              }
            : {
                project: {
                  projectId: "30000000-0000-4000-8000-000000000001",
                  workspaceId: "40000000-0000-4000-8000-000000000001",
                  name: "Alpha repair",
                  createdAt,
                  source: { kind: "sample_java", status: "ready" },
                  environment: { ...environment, createdAt },
                },
                session: {
                  sessionId: "20000000-0000-4000-8000-000000000001",
                  projectId: "30000000-0000-4000-8000-000000000001",
                  workspaceId: "40000000-0000-4000-8000-000000000001",
                  title: "Repair checkout",
                  state: "idle",
                  modelProfileId: "50000000-0000-4000-8000-000000000001",
                  createdAt,
                  updatedAt: createdAt,
                  lastActiveAt: createdAt,
                },
                turns: [],
                historyTruncated: false,
                replayAfterSequence: 0,
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);

    await expect(api.listConversations()).resolves.toMatchObject({
      conversations: [{ title: "Repair checkout", workspaceName: "Alpha repair" }],
    });
    await expect(
      api.getConversation("20000000-0000-4000-8000-000000000001"),
    ).resolves.toMatchObject({ session: { state: "idle" } });
  });

  it("loads tenant-scoped operational audit and binary Workspace content", async () => {
    const tenantId = "10000000-0000-4000-8000-000000000002";
    const versionId = "20000000-0000-4000-8000-000000000001";
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (String(input) === "/v1/operations/audit") {
        return new Response(JSON.stringify({ tenantId, events: [], truncated: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(String(input)).toBe(`/v1/workspace-versions/${versionId}/file?path=src%2FMain.java`);
      return new Response("class Main {}\n", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });
    const api = new AgentDockApi(fetchImplementation, token);

    await expect(api.getOperationalAudit()).resolves.toEqual({
      tenantId,
      events: [],
      truncated: false,
    });
    const file = await api.readWorkspaceFile(versionId, "src/Main.java");
    expect(new TextDecoder().decode(file.bytes)).toBe("class Main {}\n");
  });
});
