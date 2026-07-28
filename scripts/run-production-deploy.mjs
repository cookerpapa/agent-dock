import { spawn } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function assertDeploymentDiskHeadroom() {
  const filesystem = await statfs(repositoryRoot);
  const availableRatio = filesystem.bavail / filesystem.blocks;
  if (!Number.isFinite(availableRatio) || availableRatio < 0.15) {
    throw new Error(
      `Production deployment requires at least 15% free disk space; found ${(availableRatio * 100).toFixed(1)}%. Reclaim build caches before deploying so Kubernetes does not evict CubeSandbox services.`,
    );
  }
}

function run(script, args = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", () => rejectPromise(new Error(`${script} could not start`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`${script} failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
  });
}

await assertDeploymentDiskHeadroom();
await run("scripts/init-production.mjs");
await run("scripts/init-cubesandbox-runtime.mjs");
await run("scripts/register-cubesandbox-tool-template.mjs");
await run("scripts/production-compose.mjs", ["build"]);
await run("scripts/production-compose.mjs", ["up", "--detach", "--wait", "--remove-orphans"]);

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environment = Object.fromEntries(
  (await readFile(resolve(runtimeDirectory, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.AGENT_DOCK_HTTP_BIND_ADDRESS;
const port = environment.AGENT_DOCK_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
if (environment.AGENT_DOCK_PI_WORKER_DEPLOYMENT === "kubernetes") {
  await run("scripts/local-kubernetes-pi-workers.mjs", ["up"]);
}
const displayHost = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
process.stdout.write(`AgentDock production deployment is ready at http://${displayHost}:${port}\n`);
