import { loadCubeEgressGatewayConfig } from "./config.ts";
import { CubeEgressConfigurationPoller } from "./configuration-poller.ts";
import { createCubeEgressGateway } from "./proxy-server.ts";

const config = await loadCubeEgressGatewayConfig();
const poller = new CubeEgressConfigurationPoller(config);
await poller.start();
const server = createCubeEgressGateway({
  poller,
  audit: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
});

await new Promise<void>((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  server.listen(config.port, config.host, () => resolvePromise());
});
process.stdout.write(
  `${JSON.stringify({
    event: "cube_egress_gateway.ready",
    host: config.host,
    port: config.port,
  })}\n`,
);

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= Promise.all([
    new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
    poller.close(),
  ]).then(() => undefined);
  return closing;
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
