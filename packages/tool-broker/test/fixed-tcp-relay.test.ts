import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createFixedTcpRelay, loadFixedTcpRelayOptions } from "../src/fixed-tcp-relay.ts";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP port was missing");
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))),
  );
});

describe("fixed TCP relay", () => {
  it("dials only its operator-fixed upstream", async () => {
    const upstreamPort = await listen(
      createServer((socket) => {
        socket.pipe(socket);
      }),
    );
    const relayPort = await listen(
      createFixedTcpRelay({
        listenHost: "127.0.0.1",
        listenPort: 1,
        upstreamHost: "127.0.0.1",
        upstreamPort,
        maximumConnections: 2,
        idleTimeoutMs: 2_000,
      }),
    );
    const output = await new Promise<string>((resolvePromise, rejectPromise) => {
      const socket = connect(relayPort, "127.0.0.1");
      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error("Relay response timed out"));
      }, 2_000);
      socket.once("error", rejectPromise);
      socket.once("connect", () => socket.write("cube-relay-check"));
      socket.once("data", (bytes) => {
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(bytes.toString("utf8"));
      });
    });
    expect(output).toBe("cube-relay-check");
  });

  it("rejects unbounded or ambiguous environment configuration", () => {
    expect(
      loadFixedTcpRelayOptions({
        AGENT_DOCK_FIXED_RELAY_UPSTREAM_HOST: "cube-control.internal",
        AGENT_DOCK_FIXED_RELAY_UPSTREAM_PORT: "3000",
      }),
    ).toMatchObject({
      upstreamHost: "cube-control.internal",
      upstreamPort: 3_000,
    });
    expect(() =>
      loadFixedTcpRelayOptions({
        AGENT_DOCK_FIXED_RELAY_UPSTREAM_HOST: "https://cube.invalid",
      }),
    ).toThrow(/UPSTREAM_HOST/);
    expect(() =>
      loadFixedTcpRelayOptions({
        AGENT_DOCK_FIXED_RELAY_UPSTREAM_HOST: "cube.internal",
        AGENT_DOCK_FIXED_RELAY_MAXIMUM_CONNECTIONS: "1000",
      }),
    ).toThrow(/numeric/);
  });
});
