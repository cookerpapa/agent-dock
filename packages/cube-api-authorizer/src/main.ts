import { loadCubeApiAuthorizerConfig } from "./config.ts";
import { createCubeApiAuthorizerServer } from "./server.ts";

const config = await loadCubeApiAuthorizerConfig();
const server = createCubeApiAuthorizerServer(config.credential);
server.listen(config.port, config.host, () => {
  process.stdout.write("PiCloud Cube API authorizer ready\n");
});

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  server.close((error) => {
    if (error !== undefined) {
      process.stderr.write("PiCloud Cube API authorizer shutdown failed\n");
      process.exitCode = 1;
    }
  });
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
