import { describe, expect, it, vi } from "vitest";

import { AgentDockApi } from "../src/api.ts";

describe("tenant-aware browser API", () => {
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
                    projectName: "Alpha repair",
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
                },
                session: {
                  sessionId: "20000000-0000-4000-8000-000000000001",
                  projectId: "30000000-0000-4000-8000-000000000001",
                  workspaceId: "40000000-0000-4000-8000-000000000001",
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
      conversations: [{ projectName: "Alpha repair" }],
    });
    await expect(
      api.getConversation("20000000-0000-4000-8000-000000000001"),
    ).resolves.toMatchObject({ session: { state: "idle" } });
  });
});
