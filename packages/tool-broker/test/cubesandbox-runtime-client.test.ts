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
let runtimeState = "running";

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
        if (request.url === "/v1/terminal/open") {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.write(`${JSON.stringify({ type: "ready", pid: 73 })}\n`);
          response.write(
            `${JSON.stringify({ type: "output", data: Buffer.from("cube shell\r\n").toString("base64") })}\n`,
          );
          response.end(`${JSON.stringify({ type: "exit", exitCode: 0, signal: null })}\n`);
          return;
        }
        if (request.url?.startsWith("/v1/terminal/") === true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"kernelRelease":"cube-guest"}');
        return;
      }
      if (host.startsWith("8000-cube-runtime-1.")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html>private-preview-ok</html>");
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/volumes/pcw-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "POST" && request.url === "/volumes") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            volumeID: (body as { name?: unknown }).name,
            name: (body as { name?: unknown }).name,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "pi-cloud-tool-v1",
            state: runtimeState,
            domain: "cube.test",
            metadata: (body as { metadata?: unknown }).metadata,
            trafficAccessToken: "private-traffic-token",
            cpuCount: 1,
            memoryMB: 768,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes/cube-runtime-1/pause") {
        runtimeState = "paused";
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes/cube-runtime-1/connect") {
        runtimeState = "running";
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "pi-cloud-tool-v1",
            state: runtimeState,
            domain: "cube.test",
            metadata: { "picloud.managed": "true" },
            trafficAccessToken: "private-traffic-token-resumed",
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/sandboxes/cube-runtime-1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "pi-cloud-tool-v1",
            state: runtimeState,
            domain: "cube.test",
            metadata: { "picloud.managed": "true" },
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
              templateID: "pi-cloud-tool-v1",
              state: runtimeState,
              domain: "cube.test",
              metadata: { "picloud.managed": "true" },
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
  it("allows public egress, denies private ranges and authenticates private ingress", async () => {
    const client = new OfficialCubeSandboxRuntimeClient({
      apiUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: "k".repeat(48),
      proxyNodeIp: "127.0.0.1",
      proxyPort: port,
      proxyScheme: "http",
      sandboxDomain: "cube.test",
      egressProxyIp: "10.255.255.254",
    });
    await client.checkHealth();
    expect(observed.find((request) => request.path === "/health")).toMatchObject({
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
    });
    const volumeId = `pcw-${"a".repeat(48)}`;
    await expect(client.ensureVolume(volumeId, "picloud-posix")).resolves.toEqual({
      volumeId,
      name: volumeId,
    });
    expect(observed.find((request) => request.path === "/volumes")).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
      body: { name: volumeId, driver: "picloud-posix" },
    });
    const instance = await client.create({
      templateId: "pi-cloud-tool-v1",
      timeoutSeconds: 900,
      metadata: { "picloud.managed": "true" },
      allowInternetAccess: true,
      allowPublicTraffic: false,
      volumeMounts: [{ name: volumeId, path: "/workspace" }],
    });
    expect(instance.trafficAccessToken).toBe("private-traffic-token");
    expect(observed.find((request) => request.path === "/sandboxes")).toMatchObject({
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
      body: {
        templateID: "pi-cloud-tool-v1",
        timeout: 900,
        allow_internet_access: true,
        network: {
          allowPublicTraffic: false,
          allowOut: ["10.255.255.254/32"],
          denyOut: ["0.0.0.0/0"],
        },
        lifecycle: { on_timeout: "kill", auto_resume: false },
        volumeMounts: [{ name: volumeId, path: "/workspace" }],
      },
    });
    await expect(
      client.request(instance, {
        method: "GET",
        path: "/v1/evidence",
        timeoutMs: 1_000,
        maximumResponseBytes: 64 * 1_024,
        authority: {
          handoffSecret: `pcch_${"h".repeat(43)}`,
          fencingToken: 7,
          bindingSha256: "a".repeat(64),
        },
      }),
    ).resolves.toEqual({ kernelRelease: "cube-guest" });
    const dataRequest = observed.find((request) => request.path === "/v1/evidence");
    expect(dataRequest).toMatchObject({
      headers: {
        host: "49984-cube-runtime-1.cube.test",
        "e2b-traffic-access-token": "private-traffic-token",
        "cube-traffic-access-token": "private-traffic-token",
        "x-pi-cloud-handoff-secret": `pcch_${"h".repeat(43)}`,
        "x-pi-cloud-fencing-token": "7",
        "x-pi-cloud-binding-sha256": "a".repeat(64),
      },
    });
    await expect(
      client.requestService!(instance, {
        port: 8000,
        method: "GET",
        path: "/",
        headers: { accept: "text/html" },
        maximumResponseBytes: 64 * 1_024,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<html>private-preview-ok</html>"),
    });
    expect(observed.find((request) => request.headers.host?.startsWith("8000-"))).toMatchObject({
      headers: {
        "e2b-traffic-access-token": "private-traffic-token",
        "cube-traffic-access-token": "private-traffic-token",
      },
    });
    const terminal = await client.openTerminal(instance, {
      rows: 24,
      cols: 100,
      authority: {
        handoffSecret: `pcch_${"h".repeat(43)}`,
        fencingToken: 7,
        bindingSha256: "a".repeat(64),
      },
    });
    expect(terminal.pid).toBe(73);
    const output: Buffer[] = [];
    for await (const chunk of terminal.output) output.push(Buffer.from(chunk));
    expect(Buffer.concat(output).toString("utf8")).toBe("cube shell\r\n");
    await terminal.sendInput(Buffer.from("pwd\r"));
    await terminal.resize({ rows: 40, cols: 120 });
    await terminal.kill();
    const start = observed.find((request) => request.path === "/v1/terminal/open");
    expect(start).toMatchObject({
      headers: {
        host: "49984-cube-runtime-1.cube.test",
        "e2b-traffic-access-token": "private-traffic-token",
        "cube-traffic-access-token": "private-traffic-token",
        "x-pi-cloud-handoff-secret": `pcch_${"h".repeat(43)}`,
        "x-pi-cloud-fencing-token": "7",
        "x-pi-cloud-binding-sha256": "a".repeat(64),
      },
    });
    expect(start?.body).toEqual({ rows: 24, cols: 100 });
    expect(observed.find((request) => request.path === "/v1/terminal/input")).toMatchObject({
      body: { data: Buffer.from("pwd\r").toString("base64") },
    });
    expect(observed.find((request) => request.path === "/v1/terminal/resize")).toMatchObject({
      body: { rows: 40, cols: 120 },
    });
    await expect(client.read(instance.sandboxId)).resolves.toMatchObject({
      sandboxId: "cube-runtime-1",
      metadata: { "picloud.managed": "true" },
    });
    await expect(client.list()).resolves.toHaveLength(1);
    await client.pause(instance.sandboxId);
    await expect(client.read(instance.sandboxId)).resolves.toMatchObject({ state: "paused" });
    await expect(client.connect(instance.sandboxId, -1)).resolves.toMatchObject({
      sandboxId: instance.sandboxId,
      state: "running",
      trafficAccessToken: "private-traffic-token-resumed",
    });
    expect(observed.find((request) => request.path.endsWith("/connect"))).toMatchObject({
      body: { timeout: -1 },
    });
    await client.destroy(instance.sandboxId);
    await client.close();
  });
});
