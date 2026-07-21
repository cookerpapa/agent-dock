import { createServer, connect, type Socket } from "node:net";

const LISTEN_HOST = "0.0.0.0";
const LISTEN_PORT = 6_443;
const UPSTREAM_HOST = "agent-dock-kubernetes-host";
const UPSTREAM_PORT = 6_443;
const MAXIMUM_CONNECTIONS = 64;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const sockets = new Set<Socket>();

function track(socket: Socket): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
}

const server = createServer((downstream) => {
  if (sockets.size >= MAXIMUM_CONNECTIONS * 2) {
    downstream.destroy();
    return;
  }
  const upstream = connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
  track(downstream);
  track(upstream);
  downstream.once("error", () => upstream.destroy());
  upstream.once("error", () => downstream.destroy());
  downstream.once("close", () => upstream.destroy());
  upstream.once("close", () => downstream.destroy());
  downstream.pipe(upstream);
  upstream.pipe(downstream);
});
server.maxConnections = MAXIMUM_CONNECTIONS;

const shutdown = (): void => {
  server.close();
  for (const socket of sockets) socket.destroy();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.once("error", (error) => {
  process.stderr.write(`[kubernetes-api-relay] ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  process.stdout.write(
    `${JSON.stringify({ service: "kubernetes-api-relay", host: LISTEN_HOST, port: LISTEN_PORT })}\n`,
  );
});
