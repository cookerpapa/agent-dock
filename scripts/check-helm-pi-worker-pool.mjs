import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = join(repositoryRoot, "deploy/helm/agent-dock-pi-worker-pool");
const pinnedHelm = join(repositoryRoot, ".cache/tools/helm-v3.18.6/helm");

function command(binary, args) {
  return spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function requireSuccess(result, description) {
  assert.equal(
    result.status,
    0,
    `${description} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  return result.stdout;
}

function requireFailure(result, pattern, description) {
  assert.notEqual(result.status, 0, `${description} unexpectedly succeeded`);
  assert.match(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, pattern, description);
}

function resolveHelm() {
  const configured = process.env.AGENT_DOCK_HELM_BIN;
  if (configured !== undefined) {
    accessSync(configured, constants.X_OK);
    return configured;
  }
  if (command("helm", ["version", "--short"]).status === 0) return "helm";
  requireSuccess(command("bash", ["scripts/ensure-helm.sh"]), "Pinned Helm installation");
  accessSync(pinnedHelm, constants.X_OK);
  return pinnedHelm;
}

const helm = resolveHelm();
requireSuccess(command(helm, ["lint", chart, "--strict"]), "Pi Worker pool Helm lint");
const rendered = requireSuccess(
  command(helm, [
    "template",
    "pi-workers",
    chart,
    "--namespace",
    "agent-dock-workers",
    "--kube-version",
    "1.34.0",
  ]),
  "Pi Worker pool Helm render",
);

requireFailure(
  command(helm, [
    "template",
    "pi-workers-invalid-capability",
    chart,
    "--set",
    "runtime.timeouts.modelCapabilityTtlMs=600000",
  ]),
  /modelCapabilityTtlMs must outlive turnMs/,
  "Pi Worker Helm capability/Turn ordering",
);
requireFailure(
  command(helm, [
    "template",
    "pi-workers-invalid-grace",
    chart,
    "--set",
    "lifecycle.terminationGracePeriodSeconds=960",
  ]),
  /terminationGracePeriodSeconds cannot expire before Worker settlement/,
  "Pi Worker Helm termination/settlement ordering",
);

const resources = parseAllDocuments(rendered)
  .map((document, index) => {
    assert.equal(document.errors.length, 0, `Rendered document ${index} is invalid YAML`);
    return document.toJSON();
  })
  .filter((document) => document !== null);
assert.equal(resources.length, 5, "The Pi Worker pool resource inventory drifted");

function find(kind, name) {
  const matches = resources.filter(
    (resource) => resource.kind === kind && resource.metadata?.name === name,
  );
  assert.equal(matches.length, 1, `${kind}/${name} must be unique`);
  return matches[0];
}

const name = "agent-dock-pi-worker-primary-v1";
const serviceAccount = find("ServiceAccount", name);
assert.equal(serviceAccount.automountServiceAccountToken, false);

const service = find("Service", name);
assert.equal(service.spec.clusterIP, "None");
assert.equal(service.spec.type, undefined);
assert.equal(service.spec.externalIPs, undefined);
assert.equal(
  service.spec.ports.some((port) => port.nodePort !== undefined),
  false,
);
const statefulSet = find("StatefulSet", name);
assert.equal(statefulSet.spec.replicas, 2);
assert.equal(statefulSet.spec.serviceName, name);
assert.equal(statefulSet.spec.podManagementPolicy, "Parallel");
assert.equal(statefulSet.spec.updateStrategy.type, "OnDelete");
assert.equal(statefulSet.spec.persistentVolumeClaimRetentionPolicy.whenDeleted, "Retain");
assert.equal(statefulSet.spec.persistentVolumeClaimRetentionPolicy.whenScaled, "Retain");
assert.deepEqual(statefulSet.spec.volumeClaimTemplates[0].spec.accessModes, ["ReadWriteOncePod"]);
assert.equal(
  statefulSet.spec.volumeClaimTemplates[0].metadata.labels["agent-dock.io/worker-build-id"],
  undefined,
  "A changing Build ID must not enter the immutable PVC template",
);

const privateRegistryRendered = requireSuccess(
  command(helm, [
    "template",
    "pi-workers-private",
    chart,
    "--set",
    "global.imagePullSecrets[0].name=agent-dock-registry",
  ]),
  "Pi Worker private-registry render",
);
const privateRegistryStatefulSet = parseAllDocuments(privateRegistryRendered)
  .map((document) => document.toJSON())
  .find((resource) => resource?.kind === "StatefulSet");
assert.deepEqual(privateRegistryStatefulSet.spec.template.spec.imagePullSecrets, [
  { name: "agent-dock-registry" },
]);

const alternateBuildRendered = requireSuccess(
  command(helm, [
    "template",
    "pi-workers",
    chart,
    "--namespace",
    "agent-dock-workers",
    "--set",
    "temporal.workerBuildId=alternate-build",
  ]),
  "Pi Worker alternate Build ID render",
);
const alternateStatefulSet = parseAllDocuments(alternateBuildRendered)
  .map((document) => document.toJSON())
  .find((resource) => resource?.kind === "StatefulSet");
assert.deepEqual(
  alternateStatefulSet.spec.volumeClaimTemplates,
  statefulSet.spec.volumeClaimTemplates,
  "Changing a Worker Build ID must leave the immutable PVC template unchanged",
);

const pod = statefulSet.spec.template.spec;
assert.equal(pod.automountServiceAccountToken, false);
assert.equal(pod.enableServiceLinks, false);
assert.equal(pod.hostIPC, false);
assert.equal(pod.hostNetwork, false);
assert.equal(pod.hostPID, false);
assert.equal(pod.shareProcessNamespace, false);
assert.equal(pod.terminationGracePeriodSeconds, 1320);
assert.equal(pod.containers.length, 1);
assert.equal(
  pod.volumes.some((volume) => volume.hostPath !== undefined),
  false,
);
assert.equal(
  JSON.stringify(pod).includes("/var/run/docker.sock") ||
    JSON.stringify(pod).includes("/run/containerd"),
  false,
);

const worker = pod.containers[0];
assert.equal(worker.securityContext.allowPrivilegeEscalation, false);
assert.equal(worker.securityContext.privileged, false);
assert.equal(worker.securityContext.readOnlyRootFilesystem, true);
assert.deepEqual(worker.securityContext.capabilities.drop, ["ALL"]);
assert.ok(worker.resources.requests.cpu);
assert.ok(worker.resources.requests.memory);
assert.ok(worker.resources.limits.cpu);
assert.ok(worker.resources.limits.memory);

const environment = Object.fromEntries(
  worker.env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(environment.AGENT_DOCK_SUPERVISOR_ID, "$(POD_NAME)");
assert.equal(environment.AGENT_DOCK_SUPERVISOR_CAPACITY, "4");
assert.equal(environment.AGENT_DOCK_EXECUTION_CELL_ID, "cell-0001");
assert.equal(environment.AGENT_DOCK_EXTERNAL_WORKER_EVENT_LOG, "true");
assert.equal(
  environment.AGENT_DOCK_WORKER_EVENT_INGEST_URL,
  "http://event-gateway.agent-dock-system.svc.cluster.local:4600",
);
assert.equal(
  environment.NO_PROXY,
  "127.0.0.1,localhost,sandbox-manager,.svc,.svc.cluster.local",
  "Owner callbacks to the Sandbox Manager must bypass the trusted-plane HTTP proxy",
);
assert.equal(environment.AGENT_DOCK_TEMPORAL_TASK_QUEUE, "agent-dock-pi-runs-cell-0001-v1");
assert.equal(environment.AGENT_DOCK_TEMPORAL_WORKER_VERSIONING_ENABLED, "true");
assert.equal(environment.AGENT_DOCK_TEMPORAL_WORKER_DEPLOYMENT_NAME, "agent-dock-pi-workers");
assert.equal(environment.AGENT_DOCK_TEMPORAL_WORKER_BUILD_ID, "development");
assert.equal(
  environment.AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL.startsWith(
    `http://$(POD_NAME).${name}.$(POD_NAMESPACE).svc.`,
  ),
  true,
);
assert.equal(environment.DATABASE_URL_FILE, "/run/agent-dock-secrets/database-url");
assert.equal(environment.AGENT_DOCK_CHECKPOINT_S3_BUCKET, "agent-dock-checkpoints");
assert.equal(
  environment.AGENT_DOCK_SANDBOX_MANAGER_URLS,
  "http://sandbox-manager-0.agent-dock-system.svc.cluster.local:4300,http://sandbox-manager-1.agent-dock-system.svc.cluster.local:4300",
);
assert.equal(environment.AGENT_DOCK_MODEL_GATEWAY_ADVERTISED_URL, "http://127.0.0.1:4200");
const sandboxManagerTimeoutMs = Number(environment.AGENT_DOCK_SANDBOX_MANAGER_REQUEST_TIMEOUT_MS);
const modelCapabilityTtlMs = Number(environment.AGENT_DOCK_MODEL_GATEWAY_CAPABILITY_TTL_MS);
const modelUpstreamTimeoutMs = Number(
  environment.AGENT_DOCK_MODEL_GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS,
);
const modelRequestTimeoutMs = Number(environment.AGENT_DOCK_PI_MODEL_REQUEST_TIMEOUT_MS);
const turnTimeoutMs = Number(environment.AGENT_DOCK_PI_TURN_TIMEOUT_MS);
assert.ok(sandboxManagerTimeoutMs >= 360_000);
assert.ok(modelUpstreamTimeoutMs <= modelRequestTimeoutMs);
assert.ok(modelRequestTimeoutMs <= turnTimeoutMs);
assert.ok(modelCapabilityTtlMs >= turnTimeoutMs + 60_000);
assert.ok(
  pod.terminationGracePeriodSeconds * 1_000 >=
    turnTimeoutMs + sandboxManagerTimeoutMs + 5 * 60_000 + 60_000,
  "Pod termination must outlive the Worker drain budget and shutdown margin",
);
assert.equal(
  environment.AGENT_DOCK_OTLP_TRACES_ENDPOINT,
  undefined,
  "The default Worker pool must not require an optional tracing backend",
);

const tracedWorkerRendered = requireSuccess(
  command(helm, [
    "template",
    "pi-workers-traced",
    chart,
    "--set",
    "services.otlpTracesEndpoint=http://collector.example.test:4318/v1/traces",
  ]),
  "Pi Worker traced render",
);
const tracedWorker = parseAllDocuments(tracedWorkerRendered)
  .map((document) => document.toJSON())
  .find((resource) => resource?.kind === "StatefulSet").spec.template.spec.containers[0];
assert.equal(
  tracedWorker.env.find((entry) => entry.name === "AGENT_DOCK_OTLP_TRACES_ENDPOINT")?.value,
  "http://collector.example.test:4318/v1/traces",
);

const secret = pod.volumes.find((volume) => volume.name === "secrets")?.secret;
assert.equal(secret.secretName, "agent-dock-pi-worker-secrets");
assert.equal(secret.defaultMode, 288);
assert.equal(
  secret.items.some((item) => item.path === "database-url"),
  true,
);
assert.equal(
  secret.items.some((item) => item.path === "aws-credentials"),
  true,
);
const secretMounts = worker.volumeMounts.filter((mount) => mount.name === "secrets");
assert.deepEqual(secretMounts.map((mount) => mount.subPath).sort(), [
  "aws-credentials",
  "database-url",
  "github-gateway-token",
  "metrics-token",
  "model-credential-master-key",
  "sandbox-manager-token",
  "supervisor-enrollment-token",
  "supervisor-management-token",
  "worker-event-ingest-token",
]);
assert.equal(
  secretMounts.every(
    (mount) =>
      mount.readOnly === true &&
      mount.mountPath === `/run/agent-dock-secrets/${String(mount.subPath)}`,
  ),
  true,
  "Kubernetes Secret keys must be mounted as individual files so O_NOFOLLOW remains enforceable",
);

const networkPolicy = find("NetworkPolicy", name);
assert.deepEqual(new Set(networkPolicy.spec.policyTypes), new Set(["Ingress", "Egress"]));
assert.equal(
  networkPolicy.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 443)),
  true,
  "Explicit external CIDRs must be usable with standard HTTPS services",
);
assert.equal(
  networkPolicy.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 4600)),
  true,
  "Pi Workers must be able to reach the durable Event Gateway",
);
assert.equal(
  JSON.stringify(networkPolicy).includes('"cidr":"0.0.0.0/0"'),
  false,
  "The Worker pool must not silently add unrestricted egress",
);
find("PodDisruptionBudget", name);

for (const invalidArgs of [
  ["--set", "workerPool.replicas=1"],
  ["--set", "workerPool.capacity=17"],
  ["--set", "workerPool.executionCellId=wrong-cell"],
  ["--set", "unexpectedEscape=true"],
]) {
  const result = command(helm, ["lint", chart, "--strict", ...invalidArgs]);
  assert.notEqual(result.status, 0, `Schema unexpectedly accepted ${invalidArgs.at(-1)}`);
}
assert.notEqual(
  command(helm, ["template", "pi-workers", chart, "--set", "disruptionBudget.minAvailable=2"])
    .status,
  0,
  "Template unexpectedly accepted a disruption budget that blocks every replica",
);

const nextBuild = requireSuccess(
  command(helm, [
    "template",
    "pi-workers-next",
    chart,
    "--set",
    "workerPool.name=next-v2",
    "--set",
    "temporal.workerBuildId=revision-abcdef",
    "--set",
    `image.digest=sha256:${"a".repeat(64)}`,
  ]),
  "Pi Worker blue-green render",
);
assert.match(nextBuild, /name: agent-dock-pi-worker-next-v2/);
assert.match(nextBuild, /value: "revision-abcdef"/);
assert.match(nextBuild, new RegExp(`agent-dock/supervisor-host@sha256:${"a".repeat(64)}`));
assert.match(nextBuild, /type: OnDelete/);

const autoscaledRendered = requireSuccess(
  command(helm, [
    "template",
    "pi-workers-autoscaled",
    chart,
    "--namespace",
    "agent-dock-workers",
    "--set",
    "autoscaling.enabled=true",
    "--set",
    "autoscaling.maxReplicas=6",
  ]),
  "Pi Worker KEDA render",
);
const autoscaledResources = parseAllDocuments(autoscaledRendered)
  .map((document) => document.toJSON())
  .filter((document) => document !== null);
const scaledObject = autoscaledResources.find((resource) => resource.kind === "ScaledObject");
assert.ok(scaledObject, "Autoscaled pool must render one KEDA ScaledObject");
assert.equal(scaledObject.spec.scaleTargetRef.kind, "StatefulSet");
assert.equal(scaledObject.spec.minReplicaCount, 2);
assert.equal(scaledObject.spec.maxReplicaCount, 6);
assert.equal(scaledObject.spec.triggers[0].type, "temporal");
assert.equal(scaledObject.spec.triggers[0].metadata.queueTypes, "activity");
assert.equal(scaledObject.spec.triggers[0].metadata.workerDeploymentBuildId, "development");
assert.equal(
  autoscaledResources.filter((resource) => resource.kind === "Service").length,
  1,
  "Autoscaled Workers must use StatefulSet headless DNS instead of per-ordinal Services",
);

const localIngress = requireSuccess(
  command(helm, [
    "template",
    "pi-workers-local",
    chart,
    "--set",
    "workerPool.name=local-v1",
    "--set",
    "management.ingress.enabled=true",
    "--set",
    "management.ingress.className=traefik",
    "--set",
    "management.ingress.hostSuffix=workers.agent-dock.local",
  ]),
  "Pi Worker local management ingress render",
);
const localResources = parseAllDocuments(localIngress)
  .map((document, index) => {
    assert.equal(document.errors.length, 0, `Local rendered document ${index} is invalid YAML`);
    return document.toJSON();
  })
  .filter((document) => document !== null);
const localStatefulSet = localResources.find(
  (resource) =>
    resource.kind === "StatefulSet" && resource.metadata?.name === "agent-dock-pi-worker-local-v1",
);
assert.ok(localStatefulSet);
const localEnvironment = Object.fromEntries(
  localStatefulSet.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(
  localEnvironment.AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL,
  "http://$(POD_NAME).workers.agent-dock.local",
);
const localIngresses = localResources.filter((resource) => resource.kind === "Ingress");
assert.deepEqual(
  localIngresses.flatMap((resource) => resource.spec.rules.map((rule) => rule.host)).sort(),
  [
    "agent-dock-pi-worker-local-v1-0.metrics.workers.agent-dock.local",
    "agent-dock-pi-worker-local-v1-0.workers.agent-dock.local",
    "agent-dock-pi-worker-local-v1-1.metrics.workers.agent-dock.local",
    "agent-dock-pi-worker-local-v1-1.workers.agent-dock.local",
  ],
);
assert.equal(
  localIngresses.every((resource) => resource.spec.ingressClassName === "traefik"),
  true,
);

console.log("helm_pi_worker_pool_check_passed");
