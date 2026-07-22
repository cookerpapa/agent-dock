import { createHash, createPublicKey } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { connect as connectSocket, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  dependencyEgressPublicKeyFingerprint,
  DependencyEgressCapabilityError,
  verifyDependencyEgressCapability,
  type DependencyEgressCapabilityClaims,
} from "./capability.ts";
import { isPublicDependencyAddress } from "./address-policy.ts";

export type DependencyEgressAuditRecord = Readonly<{
  timestamp: string;
  outcome: "allowed" | "denied" | "closed";
  reason: string;
  activationHash?: string;
  host?: string;
  addressFamily?: 4 | 6;
  bytes?: number;
  durationMs?: number;
}>;

export type DependencyEgressProxyOptions = Readonly<{
  publicKey: () => Promise<string | Buffer>;
  resolveHost?: (host: string) => Promise<readonly string[]>;
  connectTarget?: (address: string, port: number) => Socket;
  audit?: (record: DependencyEgressAuditRecord) => void;
  now?: () => number;
}>;

type CapabilityUsage = {
  expiresAt: number;
  connections: number;
  active: number;
  bytes: number;
};

function activationHash(activationId: string): string {
  return createHash("sha256").update(activationId).digest("hex").slice(0, 16);
}

async function defaultResolveHost(host: string): Promise<readonly string[]> {
  const [ipv4, ipv6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const addresses = [
    ...(ipv4.status === "fulfilled" ? ipv4.value : []),
    ...(ipv6.status === "fulfilled" ? ipv6.value : []),
  ];
  return [...new Set(addresses)].slice(0, 16);
}

function parseBasicCapability(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string" || !header.startsWith("Basic ") || header.length > 24_000) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    if (!decoded.startsWith("agent-dock:")) return undefined;
    const token = decoded.slice("agent-dock:".length);
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function parseConnectTarget(value: string | undefined): { host: string; port: 443 } | undefined {
  if (value === undefined || value.length > 260) return undefined;
  const separator = value.lastIndexOf(":");
  if (separator < 1 || value.slice(separator + 1) !== "443") return undefined;
  const host = value.slice(0, separator);
  if (
    host !== host.toLowerCase() ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
  ) {
    return undefined;
  }
  return { host, port: 443 };
}

function deny(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    const challenge = status === 407 ? 'Proxy-Authenticate: Basic realm="AgentDock"\r\n' : "";
    socket.end(
      `HTTP/1.1 ${String(status)} ${reason}\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

export function createDependencyEgressProxy(options: DependencyEgressProxyOptions): Server {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const connectTarget =
    options.connectTarget ?? ((address, port) => connectSocket({ host: address, port }));
  const now = options.now ?? Date.now;
  const usage = new Map<string, CapabilityUsage>();
  const audit = (record: Omit<DependencyEgressAuditRecord, "timestamp">): void =>
    options.audit?.({ timestamp: new Date(now()).toISOString(), ...record });

  const http = createHttpServer((request, response) => {
    if (
      (request.url === "/health/live" || request.url === "/health/ready") &&
      request.method === "GET"
    ) {
      void options
        .publicKey()
        .then((publicKey) => {
          const key = createPublicKey(publicKey);
          if (key.asymmetricKeyType !== "ed25519") throw new Error("invalid key");
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(
            `${JSON.stringify({
              status: "ok",
              publicKeyFingerprint: dependencyEgressPublicKeyFingerprint(publicKey),
            })}\n`,
          );
        })
        .catch(() => {
          response.writeHead(503, { "content-length": "0", "cache-control": "no-store" });
          response.end();
        });
      return;
    }
    response.writeHead(405, { "content-length": "0", allow: "CONNECT" });
    response.end();
  });

  http.on("connect", (request: IncomingMessage, client, head) => {
    void (async () => {
      const target = parseConnectTarget(request.url);
      const token = parseBasicCapability(request.headers["proxy-authorization"]);
      if (target === undefined || token === undefined) {
        audit({ outcome: "denied", reason: "invalid_request" });
        deny(client, 407, "Proxy Authentication Required");
        return;
      }
      let claims: DependencyEgressCapabilityClaims;
      try {
        claims = verifyDependencyEgressCapability(token, await options.publicKey(), now());
      } catch (error) {
        audit({
          outcome: "denied",
          reason:
            error instanceof DependencyEgressCapabilityError ? error.code : "issuer_unavailable",
          host: target.host,
        });
        deny(client, 403, "Forbidden");
        return;
      }
      const hashedActivation = activationHash(claims.activationId);
      if (!claims.hosts.includes(target.host)) {
        audit({
          outcome: "denied",
          reason: "host_not_allowed",
          activationHash: hashedActivation,
          host: target.host,
        });
        deny(client, 403, "Forbidden");
        return;
      }
      for (const [nonce, current] of usage) {
        if (current.active === 0 && current.expiresAt <= now()) usage.delete(nonce);
      }
      const current = usage.get(claims.nonce) ?? {
        expiresAt: claims.expiresAt,
        connections: 0,
        active: 0,
        bytes: 0,
      };
      if (
        current.connections >= claims.maximumConnections ||
        current.active >= claims.maximumConcurrentConnections ||
        current.bytes >= claims.maximumBytes
      ) {
        audit({
          outcome: "denied",
          reason: "capability_quota_exhausted",
          activationHash: hashedActivation,
          host: target.host,
        });
        deny(client, 429, "Too Many Requests");
        return;
      }
      current.connections += 1;
      current.active += 1;
      usage.set(claims.nonce, current);
      let addresses: readonly string[];
      try {
        addresses = await resolveHost(target.host);
      } catch {
        addresses = [];
      }
      if (
        addresses.length < 1 ||
        addresses.length > 16 ||
        addresses.some((address) => !isPublicDependencyAddress(address))
      ) {
        current.active -= 1;
        audit({
          outcome: "denied",
          reason: addresses.length < 1 ? "dns_unavailable" : "non_public_resolution",
          activationHash: hashedActivation,
          host: target.host,
        });
        deny(client, 502, "Bad Gateway");
        return;
      }
      const address = addresses[0]!;
      const family = address.includes(":") ? 6 : 4;
      const upstream = connectTarget(address, target.port);
      const startedAt = now();
      let connectionBytes = 0;
      let finalized = false;
      const finish = (reason: string): void => {
        if (finalized) return;
        finalized = true;
        current.active = Math.max(0, current.active - 1);
        audit({
          outcome: "closed",
          reason,
          activationHash: hashedActivation,
          host: target.host,
          addressFamily: family,
          bytes: connectionBytes,
          durationMs: Math.max(0, now() - startedAt),
        });
      };
      const account = (chunk: Buffer): void => {
        connectionBytes += chunk.byteLength;
        current.bytes += chunk.byteLength;
        if (current.bytes > claims.maximumBytes) {
          client.destroy();
          upstream.destroy();
          finish("byte_limit");
        }
      };
      const timer = setTimeout(() => {
        client.destroy();
        upstream.destroy();
        finish("duration_limit");
      }, claims.maximumConnectionDurationMs);
      timer.unref();
      upstream.once("connect", () => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: AgentDock\r\n\r\n");
        if (head.byteLength > 0) {
          account(head);
          if (!upstream.destroyed) upstream.write(head);
        }
        audit({
          outcome: "allowed",
          reason: "connected",
          activationHash: hashedActivation,
          host: target.host,
          addressFamily: family,
        });
        client.on("data", account);
        upstream.on("data", account);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => {
        if (!client.destroyed) deny(client, 502, "Bad Gateway");
        finish("upstream_error");
      });
      client.once("error", () => finish("client_error"));
      client.once("close", () => {
        clearTimeout(timer);
        upstream.destroy();
        finish("client_closed");
      });
      upstream.once("close", () => {
        clearTimeout(timer);
        client.destroy();
        finish("upstream_closed");
      });
    })().catch(() => {
      audit({ outcome: "denied", reason: "proxy_internal_error" });
      deny(client, 500, "Internal Server Error");
    });
  });
  http.on("clientError", (_error, socket) => deny(socket, 400, "Bad Request"));
  return http;
}
