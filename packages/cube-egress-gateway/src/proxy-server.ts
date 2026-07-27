import { resolve4, resolve6 } from "node:dns/promises";
import {
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { request as requestHttps } from "node:https";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type { Duplex } from "node:stream";
import { isPublicAddress } from "./public-address-policy.ts";
import type { CubeEgressRuntimeConfiguration } from "./configuration-poller.ts";

const MAXIMUM_PROXY_HEADER_BYTES = 16 * 1_024;
const CONNECTION_TIMEOUT_MS = 10_000;
const CONNECTION_DURATION_MS = 5 * 60_000;

export type CubeEgressAuditRecord = Readonly<{
  timestamp: string;
  outcome: "allowed" | "denied" | "closed";
  reason: string;
  host?: string;
  revision?: number;
}>;

export type CubeEgressConfigurationSource = Readonly<{
  current: CubeEgressRuntimeConfiguration | undefined;
}>;

function deny(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function normalizedHost(value: string): string | undefined {
  const host = value.toLowerCase().replace(/\.$/, "");
  if (isIP(host) !== 0) return isPublicAddress(host) ? host : undefined;
  if (
    host.length < 4 ||
    host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
  ) {
    return undefined;
  }
  return host;
}

async function publicAddresses(host: string): Promise<readonly string[]> {
  if (isIP(host) !== 0) return isPublicAddress(host) ? [host] : [];
  const [ipv4, ipv6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const addresses = [
    ...(ipv4.status === "fulfilled" ? ipv4.value : []),
    ...(ipv6.status === "fulfilled" ? ipv6.value : []),
  ];
  const unique = [...new Set(addresses)].slice(0, 16);
  return unique.length > 0 && unique.every(isPublicAddress) ? unique : [];
}

function upstreamSocket(url: URL): Socket {
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  return url.protocol === "https:"
    ? connectTls({ host: url.hostname, port, servername: url.hostname })
    : connectTcp({ host: url.hostname, port });
}

function connectTarget(value: string | undefined): { host: string; port: 443 } | undefined {
  if (value === undefined || value.length > 280) return undefined;
  const separator = value.lastIndexOf(":");
  if (separator < 1 || value.slice(separator + 1) !== "443") return undefined;
  const host = normalizedHost(value.slice(0, separator));
  return host === undefined ? undefined : { host, port: 443 };
}

function currentEnabled(
  poller: CubeEgressConfigurationSource,
): CubeEgressRuntimeConfiguration | undefined {
  const current = poller.current;
  return current?.enabled === true && current.upstreamProxyUrl !== undefined ? current : undefined;
}

function withoutHopByHopHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = { ...headers };
  for (const name of [
    "connection",
    "proxy-connection",
    "proxy-authorization",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete output[name];
  }
  return output;
}

function filteredRequestHeaders(headers: IncomingHttpHeaders, host: string): OutgoingHttpHeaders {
  return { ...withoutHopByHopHeaders(headers), host };
}

export function createCubeEgressGateway(options: {
  poller: CubeEgressConfigurationSource;
  audit?: (record: CubeEgressAuditRecord) => void;
  now?: () => number;
}): Server {
  const now = options.now ?? Date.now;
  const audit = (record: Omit<CubeEgressAuditRecord, "timestamp">): void =>
    options.audit?.({ timestamp: new Date(now()).toISOString(), ...record });

  const server = createHttpServer((request, response) => {
    void (async () => {
      if (
        request.method === "GET" &&
        (request.url === "/health/live" || request.url === "/health/ready")
      ) {
        const ready = options.poller.current !== undefined;
        response.writeHead(ready ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(`${JSON.stringify({ status: ready ? "ok" : "not_ready" })}\n`);
        return;
      }
      const configuration = currentEnabled(options.poller);
      if (configuration === undefined) {
        response.writeHead(503, { "content-length": "0", "cache-control": "no-store" });
        response.end();
        return;
      }
      let target: URL;
      try {
        target = new URL(request.url ?? "");
      } catch {
        response.writeHead(400, { "content-length": "0" });
        response.end();
        return;
      }
      const host = normalizedHost(target.hostname);
      const port = Number(target.port || "80");
      if (
        target.protocol !== "http:" ||
        target.username.length > 0 ||
        target.password.length > 0 ||
        host === undefined ||
        port !== 80
      ) {
        audit({
          outcome: "denied",
          reason: "invalid_http_target",
          revision: configuration.revision,
        });
        response.writeHead(403, { "content-length": "0" });
        response.end();
        return;
      }
      const addresses = await publicAddresses(host).catch(() => []);
      if (addresses.length === 0) {
        audit({
          outcome: "denied",
          reason: "non_public_resolution",
          host,
          revision: configuration.revision,
        });
        response.writeHead(502, { "content-length": "0" });
        response.end();
        return;
      }
      const address = addresses[0]!;
      const absolutePath = `http://${address.includes(":") ? `[${address}]` : address}:80${target.pathname}${target.search}`;
      const upstreamRequest = (
        configuration.upstreamProxyUrl!.protocol === "https:" ? requestHttps : requestHttp
      )({
        hostname: configuration.upstreamProxyUrl!.hostname,
        port: Number(
          configuration.upstreamProxyUrl!.port ||
            (configuration.upstreamProxyUrl!.protocol === "https:" ? "443" : "80"),
        ),
        method: request.method,
        path: absolutePath,
        headers: filteredRequestHeaders(request.headers, target.host),
        timeout: CONNECTION_TIMEOUT_MS,
      });
      upstreamRequest.once("response", (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          withoutHopByHopHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
        audit({
          outcome: "allowed",
          reason: "http_forwarded",
          host,
          revision: configuration.revision,
        });
      });
      upstreamRequest.once("timeout", () => upstreamRequest.destroy());
      upstreamRequest.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { "content-length": "0" });
        response.end();
      });
      request.pipe(upstreamRequest);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502, { "content-length": "0" });
      response.end();
    });
  });

  server.on("connect", (request: IncomingMessage, client, head) => {
    void (async () => {
      const configuration = currentEnabled(options.poller);
      const target = connectTarget(request.url);
      if (configuration === undefined || target === undefined) {
        audit({
          outcome: "denied",
          reason: configuration === undefined ? "proxy_disabled" : "invalid_connect_target",
        });
        deny(client, configuration === undefined ? 503 : 403, "Forbidden");
        return;
      }
      const addresses = await publicAddresses(target.host).catch(() => []);
      if (addresses.length === 0) {
        audit({
          outcome: "denied",
          reason: "non_public_resolution",
          host: target.host,
          revision: configuration.revision,
        });
        deny(client, 502, "Bad Gateway");
        return;
      }
      const address = addresses[0]!;
      const authority = `${address.includes(":") ? `[${address}]` : address}:443`;
      const upstream = upstreamSocket(configuration.upstreamProxyUrl!);
      const timeout = setTimeout(() => {
        upstream.destroy();
        deny(client, 504, "Gateway Timeout");
      }, CONNECTION_TIMEOUT_MS);
      timeout.unref();
      const duration = setTimeout(() => {
        upstream.destroy();
        client.destroy();
      }, CONNECTION_DURATION_MS);
      duration.unref();
      let responseHeader = Buffer.alloc(0);
      const finish = (reason: string): void => {
        clearTimeout(timeout);
        clearTimeout(duration);
        audit({
          outcome: "closed",
          reason,
          host: target.host,
          revision: configuration.revision,
        });
      };
      upstream.once("connect", () => {
        upstream.write(
          [
            `CONNECT ${authority} HTTP/1.1`,
            `Host: ${authority}`,
            "Proxy-Connection: keep-alive",
            "User-Agent: AgentDock-Cube-Egress/1",
            "",
            "",
          ].join("\r\n"),
        );
      });
      const accept = (chunk: Buffer): void => {
        responseHeader = Buffer.concat([responseHeader, chunk]);
        if (responseHeader.byteLength > MAXIMUM_PROXY_HEADER_BYTES) {
          upstream.destroy();
          deny(client, 502, "Bad Gateway");
          return;
        }
        const boundary = responseHeader.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        upstream.off("data", accept);
        const header = responseHeader.subarray(0, boundary + 4).toString("latin1");
        if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(header.split("\r\n", 1)[0] ?? "")) {
          upstream.destroy();
          deny(client, 502, "Bad Gateway");
          return;
        }
        clearTimeout(timeout);
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: AgentDock\r\n\r\n");
        const remainder = responseHeader.subarray(boundary + 4);
        if (remainder.byteLength > 0) client.write(remainder);
        if (head.byteLength > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        audit({
          outcome: "allowed",
          reason: "https_tunnel",
          host: target.host,
          revision: configuration.revision,
        });
      };
      upstream.on("data", accept);
      upstream.once("error", () => {
        deny(client, 502, "Bad Gateway");
        finish("upstream_error");
      });
      upstream.once("close", () => {
        client.destroy();
        finish("upstream_closed");
      });
      client.once("close", () => {
        upstream.destroy();
        finish("client_closed");
      });
      client.once("error", () => {
        upstream.destroy();
        finish("client_error");
      });
    })().catch(() => deny(client, 502, "Bad Gateway"));
  });
  server.on("clientError", (_error, socket) => deny(socket, 400, "Bad Request"));
  return server;
}
