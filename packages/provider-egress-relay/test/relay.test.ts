import { connect, createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProviderBridgeRelay,
  createProviderHostProxy,
  loadProviderEgressRelayConfig,
  type ProviderEgressAuditRecord,
} from "../src/index.ts";

const servers: Server[] = [];
const directories: string[] = [];

async function listenTcp(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

async function listenSocket(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(path, () => resolvePromise());
  });
  servers.push(server);
}

async function response(port: number, request: string, payload?: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const socket = connect(port, "127.0.0.1");
    let value = "";
    let tunneled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error("provider relay test timed out"));
    }, 3_000);
    socket.once("error", rejectPromise);
    socket.on("data", (chunk) => {
      value += chunk.toString("utf8");
      if (!tunneled && value.includes("\r\n\r\n")) {
        tunneled = true;
        if (payload === undefined || !value.startsWith("HTTP/1.1 200")) {
          clearTimeout(timer);
          socket.destroy();
          resolvePromise(value);
          return;
        }
        socket.write(payload);
      }
      if (payload !== undefined && value.endsWith(payload)) {
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(value);
      }
    });
    socket.once("connect", () => socket.write(request));
  });
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))),
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("provider egress relay", () => {
  it("bridges an allowlisted CONNECT request through an operator upstream proxy", async () => {
    const upstreamTargets: string[] = [];
    const upstream = createHttpServer();
    upstream.on("connect", (request, socket, head) => {
      upstreamTargets.push(request.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) socket.write(head);
      socket.pipe(socket);
    });
    const upstreamPort = await listenTcp(upstream);
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-provider-relay-"));
    directories.push(directory);
    const socketPath = join(directory, "relay.sock");
    const audit: ProviderEgressAuditRecord[] = [];
    const host = createProviderHostProxy({
      allowedHosts: ["api.deepseek.com"],
      upstreamProxyUrl: new URL(`http://127.0.0.1:${String(upstreamPort)}`),
      audit: (record) => audit.push(record),
    });
    await listenSocket(host, socketPath);
    const bridgePort = await listenTcp(createProviderBridgeRelay(socketPath));

    const output = await response(
      bridgePort,
      "CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com:443\r\n\r\n",
      "provider-tunnel-bytes",
    );
    expect(output).toContain("200 Connection Established");
    expect(output).toContain("provider-tunnel-bytes");
    expect(upstreamTargets).toEqual(["api.deepseek.com:443"]);
    expect(audit.some((record) => record.outcome === "allowed")).toBe(true);

    const denied = await response(
      bridgePort,
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    );
    expect(denied).toContain("403 Forbidden");
    expect(upstreamTargets).toEqual(["api.deepseek.com:443"]);
  });

  it("validates closed relay configuration", () => {
    expect(
      loadProviderEgressRelayConfig({
        PI_CLOUD_PROVIDER_RELAY_MODE: "host",
        PI_CLOUD_PROVIDER_RELAY_SOCKET: "/tmp/relay.sock",
        PI_CLOUD_PROVIDER_RELAY_ALLOWED_HOSTS: "api.deepseek.com",
        PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY: "http://127.0.0.1:10808",
      }),
    ).toMatchObject({
      mode: "host",
      allowedHosts: ["api.deepseek.com"],
    });
    expect(() =>
      loadProviderEgressRelayConfig({
        PI_CLOUD_PROVIDER_RELAY_MODE: "host",
        PI_CLOUD_PROVIDER_RELAY_ALLOWED_HOSTS: "127.0.0.1",
      }),
    ).toThrow(/ALLOWED_HOSTS/);
    expect(() =>
      loadProviderEgressRelayConfig({
        PI_CLOUD_PROVIDER_RELAY_MODE: "bridge",
        PI_CLOUD_PROVIDER_RELAY_HOST: "0.0.0.0",
        PI_CLOUD_PROVIDER_RELAY_PORT: "0",
      }),
    ).toThrow(/PORT/);
  });

  it("fails direct mode closed on private DNS and accepts only CONNECT", async () => {
    const directTargets: string[] = [];
    const privateAudit: ProviderEgressAuditRecord[] = [];
    const privatePort = await listenTcp(
      createProviderHostProxy({
        allowedHosts: ["api.deepseek.com"],
        resolveHost: async () => ["127.0.0.1"],
        connectDirect: (address, port) => {
          directTargets.push(`${address}:${String(port)}`);
          return connect(port, address);
        },
        audit: (record) => privateAudit.push(record),
      }),
    );

    const ordinaryHttp = await response(
      privatePort,
      "GET http://api.deepseek.com/ HTTP/1.1\r\nHost: api.deepseek.com\r\n\r\n",
    );
    expect(ordinaryHttp).toContain("405 Method Not Allowed");

    const denied = await response(
      privatePort,
      "CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com:443\r\n\r\n",
    );
    expect(denied).toContain("502 Bad Gateway");
    expect(directTargets).toEqual([]);
    expect(privateAudit.some((record) => record.reason === "non_public_resolution")).toBe(true);

    const echo = createServer((socket) => socket.pipe(socket));
    const echoPort = await listenTcp(echo);
    const publicPort = await listenTcp(
      createProviderHostProxy({
        allowedHosts: ["api.deepseek.com"],
        resolveHost: async () => ["1.1.1.1"],
        connectDirect: (_address, _port) => connect(echoPort, "127.0.0.1"),
      }),
    );
    const tunneled = await response(
      publicPort,
      "CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com:443\r\n\r\n",
      "direct-provider-bytes",
    );
    expect(tunneled).toContain("200 Connection Established");
    expect(tunneled).toContain("direct-provider-bytes");
  });
});
