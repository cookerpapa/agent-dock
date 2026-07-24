import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.AGENT_DOCK_PRODUCTION_COMPOSE_OVERRIDE = resolve(
  repositoryRoot,
  "deploy/cubesandbox/compose.override.yaml",
);
await import("./production-compose.mjs");
