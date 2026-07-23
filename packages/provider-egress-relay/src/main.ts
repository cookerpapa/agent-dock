import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createProviderBridgeRelay,
  createProviderHostProxy,
  loadProviderEgressRelayConfig,
} from "./index.ts";

const config = loadProviderEgressRelayConfig();
if (config.mode === "host") {
  await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(config.socketPath);
    if (!existing.isSocket()) {
      throw new Error("Provider egress relay path is not a socket");
    }
    await unlink(config.socketPath);
  } catch (error: unknown) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )) {
      throw error;
    }
  }
}

const server =
  config.mode === "host"
    ? createProviderHostProxy({
        allowedHosts: config.allowedHosts,
        ...(config.upstreamProxyUrl === undefined
          ? {}
          : { upstreamProxyUrl: config.upstreamProxyUrl }),
        audit: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
      })
    : createProviderBridgeRelay(config.socketPath);

await new Promise<void>((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  if (config.mode === "host") {
    server.listen(config.socketPath, () => resolvePromise());
  } else {
    server.listen(config.port, config.host, () => resolvePromise());
  }
});
if (config.mode === "host") await chmod(config.socketPath, 0o660);
process.stdout.write(
  `${JSON.stringify({
    event: "provider_egress_relay.ready",
    mode: config.mode,
    upstreamProxy: config.mode === "host" && config.upstreamProxyUrl !== undefined,
  })}\n`,
);

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return closing;
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
