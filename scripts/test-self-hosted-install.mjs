import { execFile } from "node:child_process";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installer = fileURLToPath(new URL("install-self-hosted.sh", import.meta.url));

const help = await execute("bash", [installer, "--help"], { cwd: repositoryRoot });
assert.match(help.stdout, /--check-only/u);
assert.match(help.stdout, /never accepts a model API key/u);

const plan = await execute(
  "bash",
  [
    installer,
    "--print-plan",
    "--runtime-dir",
    "tmp/example-runtime",
    "--pi-workers",
    "compose",
    "--port",
    "18080",
  ],
  { cwd: repositoryRoot },
);
assert.match(plan.stdout, /Pi Worker mode:\s+compose/u);
assert.match(plan.stdout, /tmp\/example-runtime/u);
assert.match(plan.stdout, /http:\/\/127\.0\.0\.1:18080/u);

const installerSource = await readFile(installer, "utf8");
assert.match(installerSource, /\/healthz/u);
assert.doesNotMatch(installerSource, /health_url=.*\/health(?:["'])/u);

const composeWrapper = await readFile(
  fileURLToPath(new URL("production-compose.mjs", import.meta.url)),
  "utf8",
);
assert.match(
  composeWrapper,
  /new Set\(\["build", "down"/u,
  "production image build must not require a template that it is about to create",
);
const productionCompose = await readFile(
  fileURLToPath(new URL("../deploy/production/compose.yaml", import.meta.url)),
  "utf8",
);
assert.match(productionCompose, /pi-cloud\.agent-events\.raw\.v1/u);
assert.match(productionCompose, /pi-cloud\.agent-events\.accepted\.v1/u);
assert.doesNotMatch(productionCompose, /event-gateway|valkey/u);

await assert.rejects(
  execute("bash", [installer, "--print-plan", "--pi-workers", "invalid"], {
    cwd: repositoryRoot,
  }),
  (error) => {
    assert.match(error.stderr, /--pi-workers must be kubernetes or compose/u);
    return true;
  },
);

process.stdout.write("self_hosted_install_contract_ok\n");
