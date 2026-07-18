import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_MODEL_API_KEY,
  FAKE_MODEL_ID,
  FakeModelServer,
  fakeModelScenarios,
} from "../src/index.ts";

let server: FakeModelServer;

beforeEach(async () => {
  server = new FakeModelServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

function completionRequest(content: string): Record<string, unknown> {
  return {
    model: FAKE_MODEL_ID,
    messages: [{ role: "user", content }],
    stream: true,
  };
}

describe("fake model HTTP boundary", () => {
  it("publishes health and scenario discovery without authentication", async () => {
    const response = await fetch(`${server.origin}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      protocol: "openai-chat-completions",
      scenarios: fakeModelScenarios,
    });
  });

  it("refuses to expose the fixed-key test server on a non-loopback interface", () => {
    expect(() => new FakeModelServer({ host: "0.0.0.0" })).toThrow(/loopback/i);
  });

  it("rejects missing authentication and unknown scenarios", async () => {
    const unauthorized = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completionRequest("not retained")),
    });
    expect(unauthorized.status).toBe(401);

    const invalidScenario = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${FAKE_MODEL_API_KEY}`,
        "content-type": "application/json",
        "x-agent-dock-scenario": "unknown",
      },
      body: JSON.stringify(completionRequest("not retained")),
    });
    expect(invalidScenario.status).toBe(400);
    expect(server.observations).toEqual([]);
  });

  it("retains request metadata but never credentials or message content", async () => {
    const privateMarker = "PRIVATE_PROMPT_MUST_NOT_BE_RETAINED";
    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${FAKE_MODEL_API_KEY}`,
        "content-type": "application/json",
        "x-agent-dock-scenario": "text",
      },
      body: JSON.stringify(completionRequest(privateMarker)),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(server.observations).toHaveLength(1);
    expect(server.observations[0]).toMatchObject({
      scenario: "text",
      model: FAKE_MODEL_ID,
      messageCount: 1,
      toolCount: 0,
      authorizationPresent: true,
      responseStatus: 200,
      completion: "completed",
    });
    const serialized = JSON.stringify(server.observations);
    expect(serialized).not.toContain(privateMarker);
    expect(serialized).not.toContain(FAKE_MODEL_API_KEY);
  });

  it("releases a held timeout request when the client aborts", async () => {
    const controller = new AbortController();
    const request = fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${FAKE_MODEL_API_KEY}`,
        "content-type": "application/json",
        "x-agent-dock-scenario": "timeout",
      },
      body: JSON.stringify(completionRequest("abort me")),
    });
    await waitFor(() => server.activeRequests === 1);
    controller.abort();
    await expect(request).rejects.toThrow();
    await waitFor(() => server.activeRequests === 0);
    expect(server.observations.at(-1)?.completion).toBe("client_aborted");
  });

  it("destroys held requests during server shutdown", async () => {
    const request = fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${FAKE_MODEL_API_KEY}`,
        "content-type": "application/json",
        "x-agent-dock-scenario": "timeout",
      },
      body: JSON.stringify(completionRequest("stop the server")),
    });
    await waitFor(() => server.activeRequests === 1);
    await server.stop();
    await expect(request).rejects.toThrow();
    expect(server.activeRequests).toBe(0);
    expect(server.observations.at(-1)?.completion).toBe("server_stopped");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fake model server state");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
