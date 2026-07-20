import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubApiClient,
  GitHubAppAuthentication,
  GitHubGatewayClient,
  GitHubGatewayServer,
  type GitHubWebhookEvent,
} from "../src/index.ts";
import { createWorkspaceSnapshot, parseWorkspaceSnapshot } from "@agent-dock/workspace-runtime";

const SHA = {
  base: "a".repeat(40),
  tree: "b".repeat(40),
  readme: "c".repeat(40),
  old: "d".repeat(40),
  blob1: "e".repeat(40),
  blob2: "f".repeat(40),
  targetTree: "1".repeat(40),
  targetCommit: "2".repeat(40),
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function repository() {
  return {
    id: 42,
    full_name: "acme/private-repo",
    owner: { login: "acme" },
    name: "private-repo",
    private: true,
    default_branch: "main",
  };
}

function fixtureFetch() {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (url.pathname === "/app/installations/7/access_tokens") {
      return json({ token: "installation-token", expires_at: "2030-01-01T00:00:00.000Z" });
    }
    if (url.pathname === "/app/installations/7") {
      return json({
        id: 7,
        account: { id: 9, login: "acme" },
        target_type: "Organization",
        repository_selection: "selected",
        permissions: { contents: "write", pull_requests: "write", checks: "write" },
        suspended_at: null,
      });
    }
    if (url.pathname === "/installation/repositories") {
      return json({ repositories: [repository()] });
    }
    if (url.pathname === `/repositories/42/git/commits/${SHA.base}`) {
      return json({ sha: SHA.base, tree: { sha: SHA.tree } });
    }
    if (url.pathname === `/repositories/42/git/trees/${SHA.tree}`) {
      return json({
        truncated: false,
        tree: [
          { path: "README.md", mode: "100644", type: "blob", sha: SHA.readme },
          { path: "old.txt", mode: "100644", type: "blob", sha: SHA.old },
        ],
      });
    }
    if (url.pathname === `/repositories/42/git/blobs/${SHA.readme}`) {
      return json({ encoding: "base64", content: Buffer.from("base\n").toString("base64") });
    }
    if (url.pathname === `/repositories/42/git/blobs/${SHA.old}`) {
      return json({ encoding: "base64", content: Buffer.from("old\n").toString("base64") });
    }
    if (url.pathname === "/repositories/42/git/ref/heads/main") {
      return json({ object: { sha: SHA.base } });
    }
    if (url.pathname === "/repositories/42/git/blobs" && method === "POST") {
      const index = calls.filter((call) => call.path === "/repositories/42/git/blobs").length;
      return json({ sha: index === 1 ? SHA.blob1 : SHA.blob2 }, 201);
    }
    if (url.pathname === "/repositories/42/git/trees" && method === "POST") {
      return json({ sha: SHA.targetTree }, 201);
    }
    if (url.pathname === "/repositories/42/git/commits" && method === "POST") {
      return json({ sha: SHA.targetCommit }, 201);
    }
    if (url.pathname === "/repositories/42/git/refs" && method === "POST") {
      return json({ ref: "refs/heads/agent/fix" }, 201);
    }
    if (url.pathname === "/repositories/42/pulls" && method === "POST") {
      return json({ number: 12, html_url: "https://github.com/acme/private-repo/pull/12" }, 201);
    }
    if (url.pathname === "/repositories/42/check-runs" && method === "POST") {
      return json({ id: 99 }, 201);
    }
    return json({ message: "unexpected" }, 404);
  };
  return { calls, fetchImplementation };
}

function clientFixture() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fixture = fixtureFetch();
  const authentication = new GitHubAppAuthentication({
    appId: 123,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    apiBaseUrl: "http://127.0.0.1/",
    fetchImplementation: fixture.fetchImplementation,
    clock: () => new Date("2026-07-20T00:00:00.000Z"),
  });
  return {
    ...fixture,
    authentication,
    client: new GitHubApiClient(authentication, fixture.fetchImplementation),
  };
}

describe("trusted GitHub Gateway", () => {
  it("uses a signed App JWT, caches installation tokens and imports an exact canonical snapshot", async () => {
    const fixture = clientFixture();
    expect(fixture.authentication.appJwt().split(".")).toHaveLength(3);
    await expect(fixture.client.inspectInstallation(7)).resolves.toMatchObject({
      installationId: 7,
      accountLogin: "acme",
      repositories: [{ repositoryId: 42, private: true }],
    });
    const result = await fixture.client.snapshot(7, 42, SHA.base);
    expect(result.commitSha).toBe(SHA.base);
    expect(parseWorkspaceSnapshot(result.snapshot).map((file) => file.path)).toEqual([
      "README.md",
      "old.txt",
    ]);
    expect(
      fixture.calls.filter((call) => call.path === "/app/installations/7/access_tokens"),
    ).toHaveLength(1);
  });

  it("writes blobs/tree/commit/ref/PR/check without returning an installation token", async () => {
    const fixture = clientFixture();
    const snapshot = createWorkspaceSnapshot([
      { path: "README.md", executable: false, content: Buffer.from("fixed\n") },
      { path: "bin/test.sh", executable: true, content: Buffer.from("#!/bin/sh\n") },
    ]);
    await expect(
      fixture.client.deliverPullRequest({
        deliveryId: "delivery-1",
        installationId: 7,
        repositoryId: 42,
        baseBranch: "main",
        baseCommitSha: SHA.base,
        headBranch: "agent/fix",
        title: "Fix tests",
        body: "Generated by AgentDock",
        workspaceSnapshot: snapshot,
      }),
    ).resolves.toEqual({
      commitSha: SHA.targetCommit,
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/acme/private-repo/pull/12",
      checkRunId: 99,
    });
    const treeCreate = fixture.calls.find(
      (call) => call.path === "/repositories/42/git/trees" && call.method === "POST",
    );
    expect(treeCreate?.body).toMatchObject({
      base_tree: SHA.tree,
      tree: expect.arrayContaining([expect.objectContaining({ path: "old.txt", sha: null })]),
    });
    expect(JSON.stringify(fixture.calls)).not.toContain("installation-token");
  });

  it("authenticates internal RPC and verifies webhook HMAC before forwarding", async () => {
    const serviceToken = "s".repeat(64);
    const webhookSecret = "w".repeat(64);
    const received: GitHubWebhookEvent[] = [];
    const api = {
      inspectInstallation: vi.fn(async () => ({
        installationId: 7,
        accountId: 9,
        accountLogin: "acme",
        targetType: "Organization" as const,
        repositorySelection: "selected" as const,
        suspended: false,
        permissions: {},
        repositories: [],
      })),
    };
    const server = new GitHubGatewayServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken,
      webhookSecret,
      apiClient: api as unknown as GitHubApiClient,
      webhookSink: async (event) => {
        received.push(event);
      },
    });
    const address = await server.listen();
    try {
      const client = new GitHubGatewayClient({
        baseUrl: address,
        serviceToken,
        allowInsecureHttp: true,
      });
      await expect(
        client.request({ type: "installation.inspect", requestId: "request-1", installationId: 7 }),
      ).resolves.toMatchObject({ type: "installation.inspected" });
      const payload = Buffer.from(
        JSON.stringify({
          action: "suspend",
          installation: { id: 7, account: { login: "acme" } },
          repository: { id: 42, full_name: "acme/private-repo" },
        }),
      );
      const signature = `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}`;
      const accepted = await fetch(new URL("/webhooks/github", address), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-1",
          "x-github-event": "installation",
          "x-hub-signature-256": signature,
        },
        body: payload,
      });
      expect(accepted.status).toBe(202);
      expect(received).toMatchObject([
        {
          deliveryId: "delivery-1",
          installationId: 7,
          payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
      const rejected = await fetch(new URL("/webhooks/github", address), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-2",
          "x-github-event": "installation",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body: payload,
      });
      expect(rejected.status).toBe(401);
      expect(received).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
