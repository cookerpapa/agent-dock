import { createDependencyEgressProxy } from "./proxy-server.ts";
import { loadDependencyEgressProxyConfig, publicKeyFileReader } from "./config.ts";

const config = loadDependencyEgressProxyConfig();
const server = createDependencyEgressProxy({
  publicKey: publicKeyFileReader(config.publicKeyPath),
  audit: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
});

await new Promise<void>((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  server.listen(config.port, config.host, () => resolvePromise());
});
process.stdout.write("AgentDock Dependency Egress Proxy ready\n");

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return closing;
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
