import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = resolve(root, "deploy/helm/pi-cloud-pi-worker-pool");
const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";

function run(arguments_) {
  const result = spawnSync(helm, arguments_, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${arguments_.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

run(["lint", chart, "--strict"]);
const rendered = run([
  "template",
  "pi-workers",
  chart,
  "--namespace",
  "pi-cloud-workers",
  "--set",
  "autoscaling.enabled=true",
]);
assert.doesNotMatch(rendered, /temporal|execution[_-]?cell|checkpoint_s3|aws-credentials/i);

const resources = parseAllDocuments(rendered)
  .map((document) => {
    assert.equal(document.errors.length, 0);
    return document.toJSON();
  })
  .filter(Boolean);
const find = (kind) => resources.find((resource) => resource.kind === kind);
const worker = find("StatefulSet");
assert(worker);
assert.equal(worker.spec.updateStrategy.type, "RollingUpdate");
const environment = Object.fromEntries(
  worker.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(environment.DATABASE_URL_FILE, "/run/pi-cloud-secrets/database-url");
assert.equal(
  environment.DATABASE_NOTIFICATION_URL_FILE,
  "/run/pi-cloud-secrets/database-notification-url",
);
assert.equal(environment.PI_CLOUD_SUPERVISOR_CAPACITY, "4");

const scaler = find("ScaledObject");
assert(scaler);
assert.equal(scaler.spec.triggers[0].type, "postgresql");
assert.match(scaler.spec.triggers[0].metadata.query, /FROM outbox/);
assert(find("TriggerAuthentication"));
process.stdout.write("Pi Worker Helm chart uses the shared PostgreSQL queue and passed.\n");
