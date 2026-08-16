import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = resolve(root, "deploy/helm/pi-cloud-platform");
const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";
function run(arguments_) {
  const result = spawnSync(helm, arguments_, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${arguments_.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

run(["dependency", "build", chart]);
run(["lint", chart, "--strict"]);
const rendered = run(["template", "pi-cloud", chart, "--namespace", "pi-cloud-system"]);
assert.doesNotMatch(
  rendered,
  /temporal|execution[_-]?cell|kopia|minio|checkpoint_s3|aws-credentials/i,
);
const resources = parseAllDocuments(rendered)
  .map((document) => {
    assert.equal(document.errors.length, 0);
    return document.toJSON();
  })
  .filter(Boolean);
const find = (kind, name) =>
  resources.find((resource) => resource.kind === kind && resource.metadata?.name === name);
const controlPlane = find("Deployment", "pi-cloud-control-plane");
assert(controlPlane);
const environment = Object.fromEntries(
  controlPlane.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(
  environment.PI_CLOUD_DATABASE_NOTIFICATION_URL_FILE,
  "/run/pi-cloud-secrets/database-notification-url",
);
assert.match(environment.PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES, /\{supervisorId\}/);
assert(find("StatefulSet", "pi-cloud-pi-worker-primary-v1"));
assert(find("Deployment", "pi-cloud-workspace-volume-gateway"));
process.stdout.write("Platform Helm chart matches the PostgreSQL/Cube Volume architecture.\n");
