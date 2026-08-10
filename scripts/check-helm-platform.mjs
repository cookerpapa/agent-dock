import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = join(repositoryRoot, "deploy/helm/agent-dock-platform");
const pinnedHelm = join(repositoryRoot, ".cache/tools/helm-v3.18.6/helm");

function command(binary, args) {
  return spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
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

function documents(rendered) {
  return parseAllDocuments(rendered)
    .map((document, index) => {
      assert.equal(document.errors.length, 0, `Rendered document ${index} is invalid YAML`);
      return document.toJSON();
    })
    .filter((document) => document !== null);
}

const helm = resolveHelm();
requireSuccess(command(helm, ["dependency", "build", chart]), "Platform dependency build");
requireSuccess(command(helm, ["lint", chart, "--strict"]), "Platform Helm lint");
const resources = documents(
  requireSuccess(
    command(helm, [
      "template",
      "agent-dock",
      chart,
      "--namespace",
      "agent-dock-system",
      "--kube-version",
      "1.34.0",
    ]),
    "Platform Helm render",
  ),
);

function find(kind, name) {
  const matches = resources.filter(
    (resource) => resource.kind === kind && resource.metadata?.name === name,
  );
  assert.equal(matches.length, 1, `${kind}/${name} must be unique`);
  return matches[0];
}

const controlPlane = find("Deployment", "agent-dock-control-plane");
assert.equal(controlPlane.spec.replicas, 3);
assert.equal(controlPlane.spec.strategy.rollingUpdate.maxUnavailable, 0);
assert.equal(controlPlane.spec.template.spec.automountServiceAccountToken, false);
const controlPlaneContainer = controlPlane.spec.template.spec.containers[0];
const controlPlaneEnvironment = Object.fromEntries(
  controlPlaneContainer.env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(
  controlPlaneEnvironment.AGENT_DOCK_SUPERVISOR_MANAGEMENT_URL_TEMPLATES,
  "http://{supervisorId}.agent-dock-pi-worker-primary-v1.agent-dock-system.svc.cluster.local:4100",
);
assert.equal(
  controlPlaneEnvironment.AGENT_DOCK_SANDBOX_MANAGER_URLS,
  "http://sandbox-manager:4300",
);
assert.equal(
  controlPlaneEnvironment.AGENT_DOCK_DATABASE_NOTIFICATION_URL_FILE,
  "/run/agent-dock-secrets/database-notification-url",
);
assert.equal(controlPlaneEnvironment.AGENT_DOCK_EXTERNAL_WORKER_EVENT_LOG, "true");
assert.equal(
  controlPlaneEnvironment.AGENT_DOCK_WORKER_EVENT_INGEST_URL,
  "http://event-gateway:4600",
);
find("HorizontalPodAutoscaler", "agent-dock-control-plane");
find("PodDisruptionBudget", "agent-dock-control-plane");

const eventRetention = find("Deployment", "agent-dock-event-retention");
assert.equal(eventRetention.spec.replicas, 2);
assert.equal(eventRetention.spec.template.spec.automountServiceAccountToken, false);
const eventRetentionContainer = eventRetention.spec.template.spec.containers[0];
assert.deepEqual(eventRetentionContainer.command, [
  "/app/packages/control-plane/src/event-retention-main.ts",
]);
const eventRetentionEnvironment = Object.fromEntries(
  eventRetentionContainer.env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(eventRetentionEnvironment.AGENT_DOCK_EVENT_HOT_RETENTION_DAYS, "14");
assert.equal(eventRetentionEnvironment.DATABASE_URL_FILE, "/run/agent-dock-secrets/database-url");
find("NetworkPolicy", "agent-dock-event-retention");

const eventGateway = find("Deployment", "agent-dock-event-gateway");
assert.equal(eventGateway.spec.replicas, 3);
assert.equal(eventGateway.spec.strategy.rollingUpdate.maxUnavailable, 0);
assert.equal(eventGateway.spec.template.spec.automountServiceAccountToken, false);
const eventGatewayEnvironment = Object.fromEntries(
  eventGateway.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(eventGatewayEnvironment.DATABASE_URL_FILE, "/run/agent-dock-secrets/database-url");
assert.equal(
  eventGatewayEnvironment.AGENT_DOCK_WORKER_EVENT_INGEST_TOKEN_FILE,
  "/run/agent-dock-secrets/worker-event-ingest-token",
);
assert.equal(
  eventGatewayEnvironment.AGENT_DOCK_DATABASE_NOTIFICATION_URL_FILE,
  "/run/agent-dock-secrets/database-notification-url",
);
assert.equal(
  eventGatewayEnvironment.AGENT_DOCK_KAFKA_BROKERS,
  "agent-dock-kafka-bootstrap.agent-dock-eventing.svc.cluster.local:9093",
);
assert.equal(eventGatewayEnvironment.AGENT_DOCK_WORKER_EVENT_TOPIC, "agent-dock-worker-events-v1");
assert.equal(
  eventGatewayEnvironment.AGENT_DOCK_KAFKA_CA_FILE,
  "/run/agent-dock-secrets/kafka-ca.crt",
);
assert.equal(
  eventGatewayEnvironment.AGENT_DOCK_KAFKA_USERNAME_FILE,
  "/run/agent-dock-secrets/kafka-username",
);
assert.equal(
  eventGatewayEnvironment.AGENT_DOCK_KAFKA_PASSWORD_FILE,
  "/run/agent-dock-secrets/kafka-password",
);
const eventGatewayScaler = find("ScaledObject", "agent-dock-event-gateway");
assert.equal(eventGatewayScaler.spec.minReplicaCount, 3);
assert.equal(eventGatewayScaler.spec.maxReplicaCount, 32);
assert.equal(eventGatewayScaler.spec.triggers[0].type, "kafka");
assert.equal(eventGatewayScaler.spec.triggers[0].metadata.lagThreshold, "1000");
assert.equal(eventGatewayScaler.spec.triggers[0].metadata.tls, "enable");
assert.equal(eventGatewayScaler.spec.triggers[0].metadata.sasl, "scram_sha512");
assert.equal(
  eventGatewayScaler.spec.triggers[0].authenticationRef.name,
  "agent-dock-event-gateway-kafka",
);
assert.equal(
  eventGatewayScaler.spec.triggers[0].metadata.bootstrapServers,
  "agent-dock-kafka-bootstrap.agent-dock-eventing.svc.cluster.local:9093",
);
assert.equal(eventGatewayScaler.spec.triggers[1].type, "cpu");
const eventGatewayKafkaAuthentication = find(
  "TriggerAuthentication",
  "agent-dock-event-gateway-kafka",
);
assert.deepEqual(
  eventGatewayKafkaAuthentication.spec.secretTargetRef.map(({ parameter, key }) => ({
    parameter,
    key,
  })),
  [
    { parameter: "username", key: "kafka-username" },
    { parameter: "password", key: "kafka-password" },
    { parameter: "ca", key: "kafka-ca.crt" },
  ],
);
find("PodDisruptionBudget", "agent-dock-event-gateway");
find("Service", "event-gateway");

const web = find("Deployment", "agent-dock-web");
assert.equal(web.spec.replicas, 2);
assert.equal(web.spec.template.spec.automountServiceAccountToken, false);
find("HorizontalPodAutoscaler", "agent-dock-web");
find("Service", "agent-dock-web");

const sandboxManagers = find("StatefulSet", "agent-dock-sandbox-manager");
assert.equal(sandboxManagers.spec.replicas, 3);
assert.equal(sandboxManagers.spec.podManagementPolicy, "Parallel");
assert.equal(sandboxManagers.spec.template.spec.containers.length, 2);
assert.equal(sandboxManagers.spec.template.spec.automountServiceAccountToken, false);
assert.deepEqual(sandboxManagers.spec.volumeClaimTemplates[0].spec.accessModes, ["ReadWriteOnce"]);
find("Service", "sandbox-manager");
const sandboxManagerEnvironment = Object.fromEntries(
  sandboxManagers.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(sandboxManagerEnvironment.AGENT_DOCK_EXECUTION_CELL_ID, "cell-0001");
assert.equal(
  sandboxManagerEnvironment.AGENT_DOCK_SANDBOX_MANAGER_ADVERTISED_URL,
  "http://$(POD_NAME).agent-dock-sandbox-manager-headless:4300",
);

const workers = find("StatefulSet", "agent-dock-pi-worker-primary-v1");
assert.equal(workers.spec.replicas, 2);
const workerEnvironment = Object.fromEntries(
  workers.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(
  workerEnvironment.AGENT_DOCK_SUPERVISOR_MANAGEMENT_ADVERTISED_URL,
  "http://$(POD_NAME).agent-dock-pi-worker-primary-v1.$(POD_NAMESPACE).svc.cluster.local:4100",
);
assert.equal(workerEnvironment.AGENT_DOCK_EXTERNAL_WORKER_EVENT_LOG, "true");
assert.equal(workerEnvironment.AGENT_DOCK_WORKER_EVENT_INGEST_URL, "http://event-gateway:4600");
const scaledObject = find("ScaledObject", "agent-dock-pi-worker-primary-v1");
assert.equal(scaledObject.spec.minReplicaCount, 2);
assert.equal(scaledObject.spec.maxReplicaCount, 32);
assert.equal(scaledObject.spec.triggers[0].metadata.queueTypes, "activity");
assert.equal(scaledObject.spec.triggers[0].metadata.targetQueueSize, "1");

const bootstrap = find("Job", "agent-dock-database-bootstrap");
assert.equal(bootstrap.metadata.annotations["helm.sh/hook"], "pre-install,pre-upgrade");
assert.equal(bootstrap.spec.template.spec.automountServiceAccountToken, false);

const privateRegistryResources = documents(
  requireSuccess(
    command(helm, [
      "template",
      "agent-dock-private",
      chart,
      "--namespace",
      "agent-dock-system",
      "--set",
      "global.imagePullSecrets[0].name=agent-dock-registry",
    ]),
    "Platform private-registry render",
  ),
);
for (const resource of privateRegistryResources) {
  const podSpec = resource.spec?.template?.spec;
  if (podSpec === undefined) continue;
  assert.deepEqual(
    podSpec.imagePullSecrets,
    [{ name: "agent-dock-registry" }],
    `${resource.kind}/${resource.metadata?.name} must receive the global image pull secret`,
  );
}

for (const resource of resources) {
  const serialized = JSON.stringify(resource);
  assert.equal(serialized.includes("/var/run/docker.sock"), false);
  assert.equal(serialized.includes("/run/containerd"), false);
  if (resource.spec?.template?.spec !== undefined) {
    assert.equal(
      resource.spec.template.spec.volumes?.some((volume) => volume.hostPath !== undefined) ?? false,
      false,
      `${resource.kind}/${resource.metadata?.name} must not use hostPath`,
    );
    for (const container of resource.spec.template.spec.containers ?? []) {
      assert.notEqual(
        container.securityContext?.privileged,
        true,
        `${resource.kind}/${resource.metadata?.name} must not be privileged`,
      );
    }
  }
}

for (const invalidArgs of [
  ["--set", "sandboxPlane.replicas=2"],
  ["--set", "controlPlane.replicas=1"],
  ["--set", "networkPolicy.externalEgressCidrs[0]=0.0.0.0/0"],
  ["--set", "unexpectedEscape=true"],
]) {
  const result = command(helm, ["template", "invalid-platform", chart, ...invalidArgs]);
  assert.notEqual(result.status, 0, `Platform chart unexpectedly accepted ${invalidArgs.at(-1)}`);
}

const controlOnlyResources = documents(
  requireSuccess(
    command(helm, [
      "template",
      "agent-dock-global",
      chart,
      "--namespace",
      "agent-dock-system",
      "--set",
      "piWorkersEnabled=false",
      "--set",
      "executionPlaneEnabled=false",
    ]),
    "Control-only platform render",
  ),
);
assert.equal(
  controlOnlyResources.some((resource) => resource.kind === "StatefulSet"),
  false,
  "The global control-plane release must not own Cell StatefulSets",
);
for (const name of ["agent-dock-global-control-plane", "agent-dock-global-event-gateway"]) {
  assert.equal(
    controlOnlyResources.some(
      (resource) => resource.kind === "Deployment" && resource.metadata?.name === name,
    ),
    true,
    `Deployment/${name} must remain in the global release`,
  );
}

console.log("helm_platform_check_passed");
