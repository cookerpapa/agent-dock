import {
  BlockList,
  connect as connectSocket,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { resolve4 } from "node:dns/promises";
import { connect as connectTls } from "node:tls";
import type { Duplex } from "node:stream";

const CONNECT_TIMEOUT_MS = 10_000;
const CONNECTION_DURATION_MS = 180_000;

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicIpv4.addSubnet(network, prefix, "ipv4");
}

export type ProviderEgressAuditRecord = Readonly<{
  timestamp: string;
  outcome: "allowed" | "denied" | "closed";
  reason: string;
  host?: string;
  via?: "direct" | "upstream_proxy";
  durationMs?: number;
}>;

export type ProviderHostProxyOptions = Readonly<{
  allowedHosts: readonly string[];
  upstreamProxyUrl?: URL;
  resolveHost?: (host: string) => Promise<readonly string[]>;
  connectDirect?: (address: string, port: number) => Socket;
  connectUpstream?: (url: URL) => Socket;
  now?: () => number;
  audit?: (record: ProviderEgressAuditRecord) => void;
}>;

function deny(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function connectTarget(value: string | undefined): { host: string; port: 443 } | undefined {
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

async function resolvePublicIpv4(host: string): Promise<readonly string[]> {
  return [...new Set(await resolve4(host))].slice(0, 16);
}

function defaultConnectUpstream(url: URL): Socket {
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  return url.protocol === "https:"
    ? connectTls({ host: url.hostname, port, servername: url.hostname })
    : connectSocket({ host: url.hostname, port });
}

function upstreamAuthorization(url: URL): string | undefined {
  if (url.username.length === 0 && url.password.length === 0) return undefined;
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function tunnel(
  client: Duplex,
  upstream: Socket,
  head: Buffer,
  options: {
    host: string;
    via: "direct" | "upstream_proxy";
    now: () => number;
    audit?: (record: ProviderEgressAuditRecord) => void;
    onConnected: () => void;
  },
): void {
  const startedAt = options.now();
  let connected = false;
  let finalized = false;
  const connectTimer = setTimeout(() => {
    upstream.destroy();
    deny(client, 504, "Gateway Timeout");
  }, CONNECT_TIMEOUT_MS);
  connectTimer.unref();
  const durationTimer = setTimeout(() => {
    upstream.destroy();
    client.destroy();
  }, CONNECTION_DURATION_MS);
  durationTimer.unref();
  const finish = (reason: string): void => {
    if (finalized) return;
    finalized = true;
    clearTimeout(connectTimer);
    clearTimeout(durationTimer);
    options.audit?.({
      timestamp: new Date(options.now()).toISOString(),
      outcome: "closed",
      reason,
      host: options.host,
      via: options.via,
      durationMs: Math.max(0, options.now() - startedAt),
    });
  };
  upstream.once("connect", () => {
    connected = true;
    clearTimeout(connectTimer);
    options.onConnected();
    if (head.byteLength > 0 && !upstream.destroyed) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    options.audit?.({
      timestamp: new Date(options.now()).toISOString(),
      outcome: "allowed",
      reason: "connected",
      host: options.host,
      via: options.via,
    });
  });
  upstream.once("error", () => {
    if (!connected) deny(client, 502, "Bad Gateway");
    else client.destroy();
    finish("upstream_error");
  });
  upstream.once("close", () => {
    if (!client.destroyed) client.end();
    finish("upstream_closed");
  });
  client.once("error", () => {
    upstream.destroy();
    finish("client_error");
  });
  client.once("close", () => {
    upstream.destroy();
    finish("client_closed");
  });
}

export function createProviderHostProxy(options: ProviderHostProxyOptions): Server {
  const allowedHosts = new Set(options.allowedHosts);
  const resolveHost = options.resolveHost ?? resolvePublicIpv4;
  const connectDirect =
    options.connectDirect ?? ((address, port) => connectSocket({ host: address, port }));
  const connectUpstream = options.connectUpstream ?? defaultConnectUpstream;
  const now = options.now ?? Date.now;
  const audit = (
    outcome: ProviderEgressAuditRecord["outcome"],
    reason: string,
    host?: string,
  ): void =>
    options.audit?.({
      timestamp: new Date(now()).toISOString(),
      outcome,
      reason,
      ...(host === undefined ? {} : { host }),
    });

  const server = createHttpServer((_request, response) => {
    response.writeHead(405, { allow: "CONNECT", "content-length": "0" });
    response.end();
  });
  server.on("connect", (request: IncomingMessage, client, head) => {
    void (async () => {
      const target = connectTarget(request.url);
      if (target === undefined || !allowedHosts.has(target.host)) {
        audit("denied", target === undefined ? "invalid_target" : "host_not_allowed", target?.host);
        deny(client, 403, "Forbidden");
        return;
      }
      const upstreamProxy = options.upstreamProxyUrl;
      if (upstreamProxy !== undefined) {
        const upstream = connectUpstream(upstreamProxy);
        tunnel(client, upstream, head, {
          host: target.host,
          via: "upstream_proxy",
          now,
          ...(options.audit === undefined ? {} : { audit: options.audit }),
          onConnected: () => {
            const authorization = upstreamAuthorization(upstreamProxy);
            upstream.write(
              [
                `CONNECT ${target.host}:443 HTTP/1.1`,
                `Host: ${target.host}:443`,
                "Proxy-Connection: keep-alive",
                "User-Agent: AgentDock-Provider-Egress/1",
                ...(authorization === undefined ? [] : [`Proxy-Authorization: ${authorization}`]),
                "",
                "",
              ].join("\r\n"),
            );
          },
        });
        return;
      }

      let addresses: readonly string[];
      try {
        addresses = await resolveHost(target.host);
      } catch {
        addresses = [];
      }
      if (
        addresses.length < 1 ||
        addresses.length > 16 ||
        addresses.some((address) => nonPublicIpv4.check(address, "ipv4"))
      ) {
        audit(
          "denied",
          addresses.length < 1 ? "dns_unavailable" : "non_public_resolution",
          target.host,
        );
        deny(client, 502, "Bad Gateway");
        return;
      }
      const upstream = connectDirect(addresses[0]!, target.port);
      tunnel(client, upstream, head, {
        host: target.host,
        via: "direct",
        now,
        ...(options.audit === undefined ? {} : { audit: options.audit }),
        onConnected: () => {
          client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: AgentDock\r\n\r\n");
        },
      });
    })().catch(() => {
      deny(client, 502, "Bad Gateway");
    });
  });
  return server;
}

export function createProviderBridgeRelay(socketPath: string): Server {
  return createServer((client) => {
    const hostRelay = connectSocket({ path: socketPath });
    client.pipe(hostRelay);
    hostRelay.pipe(client);
    client.once("error", () => hostRelay.destroy());
    client.once("close", () => hostRelay.destroy());
    hostRelay.once("error", () => client.destroy());
    hostRelay.once("close", () => client.end());
  });
}
