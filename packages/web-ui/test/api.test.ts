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

  it("creates an empty project workspace without exposing import controls", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("/v1/projects");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "Pinned repository",
        source: { kind: "empty" },
      });
      return new Response(
        JSON.stringify({
          projectId: "20000000-0000-4000-8000-000000000001",
          workspaceId: "30000000-0000-4000-8000-000000000001",
          name: "Pinned repository",
          createdAt: "2026-07-19T00:00:00.000Z",
          environment,
          source: { kind: "empty", status: "ready" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);
    await expect(api.createProject("Pinned repository")).resolves.toMatchObject({
      source: { kind: "empty", status: "ready" },
    });
  });

  it("allows internal acceptance clients to request the sample Java fixture explicitly", async () => {
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("/v1/projects");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "Candidate fixture",
        source: { kind: "sample_java" },
      });
      return new Response(
        JSON.stringify({
          projectId: "20000000-0000-4000-8000-000000000001",
          workspaceId: "30000000-0000-4000-8000-000000000001",
          name: "Candidate fixture",
          createdAt: "2026-07-19T00:00:00.000Z",
          environment,
          source: { kind: "sample_java", status: "ready" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);
    await expect(
      api.createProject("Candidate fixture", { kind: "sample_java" }),
    ).resolves.toMatchObject({
      source: { kind: "sample_java", status: "ready" },
    });
  });

  it("sends the selected Sandbox retention policy when creating a conversation", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("/v1/projects/20000000-0000-4000-8000-000000000001/sessions");
      expect(JSON.parse(String(init?.body))).toEqual({
        workspaceId: "30000000-0000-4000-8000-000000000001",
        title: "Persistent development environment",
        sandboxRetention: "persistent",
      });
      return new Response(
        JSON.stringify({
          sessionId: "40000000-0000-4000-8000-000000000001",
          title: "Persistent development environment",
          projectId: "20000000-0000-4000-8000-000000000001",
          workspaceId: "30000000-0000-4000-8000-000000000001",
          state: "cold",
          sandboxRetention: "persistent",
          modelProfileId: "50000000-0000-4000-8000-000000000001",
          createdAt: "2026-07-19T00:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation);
    await expect(
      api.createSession(
        "20000000-0000-4000-8000-000000000001",
        "30000000-0000-4000-8000-000000000001",
        "Persistent development environment",
        "persistent",
      ),
    ).resolves.toMatchObject({ sandboxRetention: "persistent" });
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
                    sandboxRetention: "ephemeral",
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
                  sandboxRetention: "ephemeral",
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

  it("loads a Pi tree and creates an idempotent conversation fork", async () => {
    const sessionId = "20000000-0000-4000-8000-000000000011";
    const childSessionId = "20000000-0000-4000-8000-000000000012";
    const turnId = "20000000-0000-4000-8000-000000000013";
    const entryId = "20000000-0000-4000-8000-000000000014";
    const createdAt = "2026-08-15T00:00:00.000Z";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (init?.method === "GET") {
        expect(path).toBe(`/v1/conversations/${sessionId}/tree?view=full`);
        return new Response(
          JSON.stringify({
            rootSessionId: sessionId,
            currentSessionId: sessionId,
            view: "full",
            branches: [
              {
                sessionId,
                title: "Root",
                parentSessionId: null,
                forkedFromTurnId: null,
                forkedFromEntryId: null,
                current: true,
                entries: [
                  {
                    entryId,
                    parentEntryId: null,
                    turnId,
                    role: "assistant",
                    text: "done",
                    finalAssistant: true,
                    createdAt,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(path).toBe(`/v1/conversations/${sessionId}/forks`);
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("fork:test");
      expect(JSON.parse(String(init?.body))).toEqual({
        turnId,
        entryId,
        title: "Alternative",
      });
      return new Response(
        JSON.stringify({
          session: {
            sessionId: childSessionId,
            title: "Alternative",
            projectId: "30000000-0000-4000-8000-000000000001",
            workspaceId: "40000000-0000-4000-8000-000000000001",
            state: "cold",
            sandboxRetention: "ephemeral",
            modelProfileId: "50000000-0000-4000-8000-000000000001",
            createdAt,
          },
          parentSessionId: sessionId,
          forkedFromTurnId: turnId,
          forkedFromEntryId: entryId,
          replayed: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation);
    await expect(api.getConversationTree(sessionId, "full")).resolves.toMatchObject({
      branches: [{ entries: [{ entryId }] }],
    });
    await expect(
      api.forkConversation(sessionId, turnId, entryId, "Alternative", "fork:test"),
    ).resolves.toMatchObject({ session: { sessionId: childSessionId } });
  });

  it("loads binary Workspace content", async () => {
    const versionId = "20000000-0000-4000-8000-000000000001";
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(String(input)).toBe(`/v1/workspace-versions/${versionId}/file?path=src%2FMain.java`);
      return new Response("class Main {}\n", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });
    const api = new AgentDockApi(fetchImplementation, token);

    const file = await api.readWorkspaceFile(versionId, "src/Main.java");
    expect(new TextDecoder().decode(file.bytes)).toBe("class Main {}\n");
  });

  it("requests subsequent immutable Workspace file pages with an encoded cursor", async () => {
    const versionId = "20000000-0000-4000-8000-000000000001";
    const cursor = "src/目录/Main.java";
    const token = `adk_10000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(
        `/v1/workspace-versions/${versionId}/files?cursor=${encodeURIComponent(cursor)}`,
      );
      return new Response(
        JSON.stringify({
          versionId,
          files: [],
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const api = new AgentDockApi(fetchImplementation, token);

    await expect(api.listWorkspaceFiles(versionId, cursor)).resolves.toEqual({
      versionId,
      files: [],
      truncated: false,
    });
  });
});
