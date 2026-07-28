import { connect, createServer, type Server, type Socket } from "node:net";

const relaySockets = new WeakMap<Server, Set<Socket>>();

export type FixedTcpRelayOptions = Readonly<{
  listenHost: "0.0.0.0" | "127.0.0.1";
  listenPort: number;
  upstreamHost: string;
  upstreamPort: number;
  maximumConnections: number;
  idleTimeoutMs: number;
}>;

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError("Fixed TCP relay numeric configuration is invalid");
  }
  return parsed;
}

function host(value: string | undefined): string {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 253 ||
    /[\u0000-\u0020\u007f/?#@:[\]]/.test(value)
  ) {
    throw new TypeError("AGENT_DOCK_FIXED_RELAY_UPSTREAM_HOST is invalid");
  }
  return value;
}

export function loadFixedTcpRelayOptions(
  environment: NodeJS.ProcessEnv = process.env,
): FixedTcpRelayOptions {
  const listenHost = environment.AGENT_DOCK_FIXED_RELAY_LISTEN_HOST ?? "0.0.0.0";
  if (listenHost !== "0.0.0.0" && listenHost !== "127.0.0.1") {
    throw new TypeError("AGENT_DOCK_FIXED_RELAY_LISTEN_HOST is invalid");
  }
  return {
    listenHost,
    listenPort: integer(environment.AGENT_DOCK_FIXED_RELAY_LISTEN_PORT, 8_080, 1, 65_535),
    upstreamHost: host(environment.AGENT_DOCK_FIXED_RELAY_UPSTREAM_HOST),
    upstreamPort: integer(environment.AGENT_DOCK_FIXED_RELAY_UPSTREAM_PORT, 8_080, 1, 65_535),
    maximumConnections: integer(environment.AGENT_DOCK_FIXED_RELAY_MAXIMUM_CONNECTIONS, 64, 1, 256),
    idleTimeoutMs: integer(
      environment.AGENT_DOCK_FIXED_RELAY_IDLE_TIMEOUT_MS,
      5 * 60_000,
      1_000,
      60 * 60_000,
    ),
  };
}

export function createFixedTcpRelay(options: FixedTcpRelayOptions): Server {
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(options.idleTimeoutMs, () => socket.destroy());
  };
  const server = createServer((downstream) => {
    if (sockets.size >= options.maximumConnections * 2) {
      downstream.destroy();
      return;
    }
    const upstream = connect({
      host: options.upstreamHost,
      port: options.upstreamPort,
    });
    track(downstream);
    track(upstream);
    downstream.once("error", () => upstream.destroy());
    upstream.once("error", () => downstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  relaySockets.set(server, sockets);
  server.maxConnections = options.maximumConnections;
  server.once("close", () => {
    for (const socket of sockets) socket.destroy();
  });
  return server;
}

function closeFixedTcpRelay(server: Server): void {
  server.close();
  for (const socket of relaySockets.get(server) ?? []) socket.destroy();
}

if (process.argv[1] === import.meta.filename) {
  const options = loadFixedTcpRelayOptions();
  const server = createFixedTcpRelay(options);
  server.once("error", (error) => {
    process.stderr.write(`[fixed-tcp-relay] ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(options.listenPort, options.listenHost, () => {
    process.stdout.write(
      `${JSON.stringify({
        service: "fixed-tcp-relay",
        listenHost: options.listenHost,
        listenPort: options.listenPort,
        upstreamHost: options.upstreamHost,
        upstreamPort: options.upstreamPort,
      })}\n`,
    );
  });
  const close = (): void => {
    closeFixedTcpRelay(server);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
