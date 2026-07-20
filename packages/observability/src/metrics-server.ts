import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Registry } from "prom-client";

export type MetricsEndpoint = Readonly<{
  port: number;
  close(): Promise<void>;
}>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export async function startMetricsEndpoint(options: {
  host: string;
  port: number;
  token: string;
  registry: Registry;
}): Promise<MetricsEndpoint> {
  if (options.token.length < 32 || options.token.length > 512 || /[\r\n\0]/.test(options.token)) {
    throw new TypeError("Metrics bearer token is invalid");
  }
  const expected = digest(options.token);
  const server: Server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok\n");
      return;
    }
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
      return;
    }
    const authorization = request.headers.authorization;
    const supplied =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    const suppliedDigest = digest(supplied);
    if (!timingSafeEqual(expected, suppliedDigest)) {
      response
        .writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": "Bearer",
        })
        .end("unauthorized\n");
      return;
    }
    const body = await options.registry.metrics();
    response.writeHead(200, { "content-type": options.registry.contentType }).end(body);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Metrics endpoint failed");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
        server.closeAllConnections();
      }),
  };
}
