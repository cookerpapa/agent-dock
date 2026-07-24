import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OfficialCubeSandboxRuntimeClient } from "../src/index.ts";

type ObservedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

let server: Server;
let port: number;
const observed: ObservedRequest[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const body =
        bytes.byteLength === 0 ? undefined : (JSON.parse(bytes.toString("utf8")) as unknown);
      observed.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body,
      });
      const host = request.headers.host ?? "";
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
        return;
      }
      if (host.startsWith("49984-cube-runtime-1.")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"kernelRelease":"cube-guest"}');
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "agent-dock-tool-v1",
            state: "running",
            domain: "cube.test",
            metadata: (body as { metadata?: unknown }).metadata,
            trafficAccessToken: "private-traffic-token",
            cpuCount: 1,
            memoryMB: 768,
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/sandboxes/cube-runtime-1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "agent-dock-tool-v1",
            state: "running",
            domain: "cube.test",
            metadata: { "agentdock.managed": "true" },
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/v2/sandboxes?limit=1000") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            {
              sandboxID: "cube-runtime-1",
              templateID: "agent-dock-tool-v1",
              state: "running",
              domain: "cube.test",
              metadata: { "agentdock.managed": "true" },
            },
          ]),
        );
        return;
      }
      if (request.method === "DELETE" && request.url === "/sandboxes/cube-runtime-1") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("official CubeSandbox HTTP compatibility client", () => {
  it("forces private deny-all creation and authenticates both planes", async () => {
    const client = new OfficialCubeSandboxRuntimeClient({
      apiUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: "k".repeat(48),
      proxyNodeIp: "127.0.0.1",
      proxyPort: port,
      proxyScheme: "http",
      sandboxDomain: "cube.test",
    });
    await client.checkHealth();
    expect(observed.find((request) => request.path === "/health")).toMatchObject({
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
    });
    const instance = await client.create({
      templateId: "agent-dock-tool-v1",
      timeoutSeconds: 900,
      metadata: { "agentdock.managed": "true" },
      allowInternetAccess: false,
      allowPublicTraffic: false,
    });
    expect(instance.trafficAccessToken).toBe("private-traffic-token");
    expect(observed.find((request) => request.path === "/sandboxes")).toMatchObject({
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
      body: {
        templateID: "agent-dock-tool-v1",
        timeout: 900,
        allow_internet_access: false,
        network: { allowPublicTraffic: false },
      },
    });
    await expect(
      client.request(instance, {
        method: "GET",
        path: "/v1/evidence",
        timeoutMs: 1_000,
        maximumResponseBytes: 64 * 1_024,
      }),
    ).resolves.toEqual({ kernelRelease: "cube-guest" });
    const dataRequest = observed.find((request) => request.path === "/v1/evidence");
    expect(dataRequest).toMatchObject({
      headers: {
        host: "49984-cube-runtime-1.cube.test",
        "e2b-traffic-access-token": "private-traffic-token",
        "cube-traffic-access-token": "private-traffic-token",
      },
    });
    await expect(client.read(instance.sandboxId)).resolves.toMatchObject({
      sandboxId: "cube-runtime-1",
      metadata: { "agentdock.managed": "true" },
    });
    await expect(client.list()).resolves.toHaveLength(1);
    await client.destroy(instance.sandboxId);
    await client.close();
  });
});
