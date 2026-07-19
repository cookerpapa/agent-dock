import { describe, expect, it, vi } from "vitest";

import { AgentDockApi } from "../src/api.ts";

describe("tenant-aware browser API", () => {
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
});
