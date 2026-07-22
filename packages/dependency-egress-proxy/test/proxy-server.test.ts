import { generateKeyPairSync } from "node:crypto";
import { createServer as createTcpServer, connect, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDependencyEgressProxy,
  dependencyEgressPublicKeyFingerprint,
  mintDependencyEgressCapability,
  type DependencyEgressAuditRecord,
} from "../src/index.ts";

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000001";
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

async function response(port: number, request: string, tunnelPayload?: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const socket = connect(port, "127.0.0.1");
    let value = "";
    let tunneled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error("proxy test timed out"));
    }, 3_000);
    socket.once("error", rejectPromise);
    socket.on("data", (chunk) => {
      value += chunk.toString("utf8");
      if (!tunneled && value.includes("\r\n\r\n")) {
        tunneled = true;
        if (tunnelPayload === undefined || !value.startsWith("HTTP/1.1 200")) {
          clearTimeout(timer);
          socket.destroy();
          resolvePromise(value);
          return;
        }
        socket.write(tunnelPayload);
      }
      if (tunnelPayload !== undefined && value.endsWith(tunnelPayload)) {
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
});

describe("dependency CONNECT proxy", () => {
  it("tunnels only an authenticated exact HTTPS host and audits without the token", async () => {
    const target = createTcpServer((socket) => socket.pipe(socket));
    const targetPort = await listen(target);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { token } = mintDependencyEgressCapability({
      privateKey,
      activationId: ACTIVATION_ID,
      hosts: ["registry.npmjs.org"],
      ttlMs: 60_000,
    });
    const audit: DependencyEgressAuditRecord[] = [];
    const proxy = createDependencyEgressProxy({
      publicKey: async () => publicKey.export({ type: "spki", format: "pem" }),
      resolveHost: async () => ["1.1.1.1"],
      connectTarget: () => connect(targetPort, "127.0.0.1"),
      audit: (record) => audit.push(record),
    });
    const proxyPort = await listen(proxy);
    const health = await response(
      proxyPort,
      "GET /health/ready HTTP/1.1\r\nHost: proxy\r\nConnection: close\r\n\r\n",
    );
    expect(health).toContain("200 OK");
    expect(health).toContain(
      dependencyEgressPublicKeyFingerprint(publicKey.export({ type: "spki", format: "pem" })),
    );
    const challenge = await response(
      proxyPort,
      "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n",
    );
    expect(challenge).toContain("407 Proxy Authentication Required");
    expect(challenge).toContain('Proxy-Authenticate: Basic realm="AgentDock"');
    const authorization = Buffer.from(`agent-dock:${token}`).toString("base64");
    const output = await response(
      proxyPort,
      `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`,
      "dependency-bytes",
    );
    expect(output).toContain("200 Connection Established");
    expect(output).toContain("dependency-bytes");
    expect(audit.some((record) => record.outcome === "allowed")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(token);

    const denied = await response(
      proxyPort,
      `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`,
    );
    expect(denied).toContain("403 Forbidden");
  });

  it("rejects every connection when DNS includes a non-public address", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { token } = mintDependencyEgressCapability({
      privateKey,
      activationId: ACTIVATION_ID,
      hosts: ["registry.npmjs.org"],
      ttlMs: 60_000,
    });
    const proxy = createDependencyEgressProxy({
      publicKey: async () => publicKey.export({ type: "spki", format: "pem" }),
      resolveHost: async () => ["1.1.1.1", "127.0.0.1"],
    });
    const proxyPort = await listen(proxy);
    const authorization = Buffer.from(`agent-dock:${token}`).toString("base64");
    const denied = await response(
      proxyPort,
      `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`,
    );
    expect(denied).toContain("502 Bad Gateway");
  });
});
