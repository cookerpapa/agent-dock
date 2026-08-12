import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CubeEgressConfigurationPoller } from "../src/configuration-poller.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe("Cube egress configuration poller", () => {
  it("authenticates and hot-loads a later committed revision", async () => {
    let revision = 1;
    const observedTokens: string[] = [];
    const server = createServer((request, response) => {
      observedTokens.push(String(request.headers["x-agent-dock-internal-token"] ?? ""));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          enabled: true,
          upstreamProxyUrl: "http://127.0.0.1:7890",
          revision,
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const poller = new CubeEgressConfigurationPoller({
      controlPlaneUrl: `http://127.0.0.1:${String(port)}/v1/internal/cube-egress-configuration`,
      serviceToken: "s".repeat(48),
      pollIntervalMs: 250,
    });
    try {
      await poller.start();
      const initialDeadline = Date.now() + 2_000;
      while (poller.current?.revision !== 1 && Date.now() < initialDeadline) {
        await delay(10);
      }
      expect(poller.current).toMatchObject({ enabled: true, revision: 1 });
      revision = 2;
      const deadline = Date.now() + 2_000;
      while (poller.current?.revision !== 2 && Date.now() < deadline) {
        await delay(50);
      }
      expect(poller.current).toMatchObject({ enabled: true, revision: 2 });
      expect(observedTokens.every((token) => token === "s".repeat(48))).toBe(true);
    } finally {
      await poller.close();
    }
  });

  it("starts fail-closed and becomes ready after the Control Plane recovers", async () => {
    let available = false;
    const server = createServer((_request, response) => {
      if (!available) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          enabled: false,
          revision: 9,
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const poller = new CubeEgressConfigurationPoller({
      controlPlaneUrl: `http://127.0.0.1:${String(port)}/v1/internal/cube-egress-configuration`,
      serviceToken: "s".repeat(48),
      pollIntervalMs: 25,
    });
    try {
      await poller.start();
      expect(poller.current).toBeUndefined();
      available = true;
      const deadline = Date.now() + 1_000;
      while (poller.current === undefined && Date.now() < deadline) {
        await delay(10);
      }
      expect(poller.current).toMatchObject({ enabled: false, revision: 9 });
    } finally {
      await poller.close();
    }
  });
});
