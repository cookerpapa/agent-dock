import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { authorizeCubeApiRequest } from "./authorization.ts";

const MAXIMUM_BODY_BYTES = 4 * 1_024;

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

async function discardBoundedBody(request: NodeJS.ReadableStream): Promise<boolean> {
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAXIMUM_BODY_BYTES) return false;
  }
  return true;
}

export function createCubeApiAuthorizerServer(credential: string): Server {
  return createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") {
      response.statusCode = 200;
      response.end('{"status":"ok"}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/verify") {
      response.statusCode = 404;
      response.end('{"error":"not_found"}');
      return;
    }
    if (!(await discardBoundedBody(request))) {
      response.statusCode = 413;
      response.end('{"error":"body_too_large"}');
      return;
    }
    const authorization = header(request.headers, "authorization");
    const apiKey = header(request.headers, "x-api-key");
    const requestPath = header(request.headers, "x-request-path");
    const requestMethod = header(request.headers, "x-request-method");
    const result = authorizeCubeApiRequest(credential, {
      ...(authorization === undefined ? {} : { authorization }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(requestPath === undefined ? {} : { requestPath }),
      ...(requestMethod === undefined ? {} : { requestMethod }),
    });
    if (result === "allow") {
      response.statusCode = 200;
      response.end('{"allowed":true}');
      return;
    }
    response.statusCode = result === "invalid_credential" ? 401 : 403;
    response.end(`{"error":"${result}"}`);
  });
}
