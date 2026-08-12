import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CubeEgressRuntimeConfiguration } from "../src/configuration-poller.ts";
import { createCubeEgressGateway, type CubeEgressAuditRecord } from "../src/proxy-server.ts";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

async function upstream(label: string): Promise<number> {
  return listen(
    createServer((incoming, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "x-observed-target": incoming.url ?? "",
      });
      response.end(label);
    }),
  );
}

async function throughGateway(
  gatewayPort: number,
  target: string,
): Promise<{ status: number; body: string; target?: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        method: "GET",
        path: target,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ...(response.headers["x-observed-target"] === undefined
              ? {}
              : { target: String(response.headers["x-observed-target"]) }),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("Cube egress gateway", () => {
  it("stays live but unready before its first durable configuration", async () => {
    const gateway = createCubeEgressGateway({ poller: { current: undefined } });
    const gatewayPort = await listen(gateway);
    await expect(throughGateway(gatewayPort, "/health/live")).resolves.toMatchObject({
      status: 200,
      body: '{"status":"ok","configured":false}\n',
    });
    await expect(throughGateway(gatewayPort, "/health/ready")).resolves.toMatchObject({
      status: 503,
      body: '{"status":"not_ready","configured":false}\n',
    });
  });

  it("hot-switches new requests without restarting and keeps DNS resolution out of the proxy", async () => {
    const firstPort = await upstream("first");
    const secondPort = await upstream("second");
    let current: CubeEgressRuntimeConfiguration = {
      enabled: true,
      upstreamProxyUrl: new URL(`http://127.0.0.1:${String(firstPort)}`),
      revision: 1,
    };
    const audits: CubeEgressAuditRecord[] = [];
    const gateway = createCubeEgressGateway({
      poller: {
        get current() {
          return current;
        },
      },
      audit: (record) => audits.push(record),
    });
    const gatewayPort = await listen(gateway);

    await expect(throughGateway(gatewayPort, "http://8.8.8.8/probe?a=1")).resolves.toEqual({
      status: 200,
      body: "first",
      target: "http://8.8.8.8:80/probe?a=1",
    });
    current = {
      enabled: true,
      upstreamProxyUrl: new URL(`http://127.0.0.1:${String(secondPort)}`),
      revision: 2,
    };
    await expect(throughGateway(gatewayPort, "http://8.8.8.8/probe?a=2")).resolves.toEqual({
      status: 200,
      body: "second",
      target: "http://8.8.8.8:80/probe?a=2",
    });
    expect(
      audits.filter(({ outcome }) => outcome === "allowed").map(({ revision }) => revision),
    ).toEqual([1, 2]);
  });

  it("rejects private targets before forwarding anything upstream", async () => {
    const upstreamPort = await upstream("must-not-be-reached");
    const gateway = createCubeEgressGateway({
      poller: {
        current: {
          enabled: true,
          upstreamProxyUrl: new URL(`http://127.0.0.1:${String(upstreamPort)}`),
          revision: 7,
        },
      },
    });
    const gatewayPort = await listen(gateway);
    await expect(throughGateway(gatewayPort, "http://127.0.0.1/private")).resolves.toMatchObject({
      status: 403,
      body: "",
    });
  });
});
