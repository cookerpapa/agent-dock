import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = join(repositoryRoot, "deploy/helm/agent-dock-execution-plane");
const pinnedHelm = join(repositoryRoot, ".cache/tools/helm-v3.18.6/helm");

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return result;
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
  const system = command("helm", ["version", "--short"]);
  if (system.status === 0) return "helm";
  requireSuccess(command("bash", ["scripts/ensure-helm.sh"]), "Pinned Helm installation");
  accessSync(pinnedHelm, constants.X_OK);
  return pinnedHelm;
}

const helm = resolveHelm();
requireSuccess(command(helm, ["lint", chart, "--strict"]), "Helm lint");
const rendered = requireSuccess(
  command(helm, [
    "template",
    "agent-dock-execution-plane",
    chart,
    "--namespace",
    "default",
    "--kube-version",
    "1.34.0",
  ]),
  "Helm render",
);

const documents = parseAllDocuments(rendered).map((document, index) => {
  assert.equal(document.errors.length, 0, `Rendered document ${index} is invalid YAML`);
  return document.toJSON();
});
const resources = documents.filter((document) => document !== null);
assert.equal(resources.length, 29, "The execution-plane chart resource inventory drifted");

function find(kind, name, namespace) {
  const matches = resources.filter(
    (resource) =>
      resource.kind === kind &&
      resource.metadata?.name === name &&
      (namespace === undefined || resource.metadata?.namespace === namespace),
  );
  assert.equal(matches.length, 1, `${kind}/${namespace ?? "cluster"}/${name} must be unique`);
  return matches[0];
}

const namespaces = [
  "agent-dock-system",
  "agent-dock-sandboxes",
  "agent-dock-importers",
  "agent-dock-egress",
];
for (const name of namespaces) {
  const namespace = find("Namespace", name);
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/audit"], "restricted");
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/warn"], "restricted");
}

const runtimeClass = find("RuntimeClass", "agent-dock-gvisor");
assert.equal(runtimeClass.handler, "runsc");
assert.equal(runtimeClass.metadata.annotations["agent-dock.io/platform"], "kvm");
assert.deepEqual(runtimeClass.scheduling.nodeSelector, {
  "agent-dock.io/sandbox-runtime": "gvisor",
});
assert.deepEqual(runtimeClass.scheduling.tolerations, [
  {
    key: "agent-dock.io/sandbox-runtime",
    operator: "Equal",
    value: "gvisor",
    effect: "NoSchedule",
  },
]);

for (const [name, namespace] of [
  ["sandbox-manager", "agent-dock-system"],
  ["untrusted-tool", "agent-dock-sandboxes"],
  ["repository-importer", "agent-dock-importers"],
  ["dependency-egress-proxy", "agent-dock-egress"],
]) {
  assert.equal(find("ServiceAccount", name, namespace).automountServiceAccountToken, false);
}
const managerToken = find("Secret", "sandbox-manager-token", "agent-dock-system");
assert.equal(managerToken.type, "kubernetes.io/service-account-token");
assert.equal(
  managerToken.metadata.annotations["kubernetes.io/service-account.name"],
  "sandbox-manager",
);

for (const resource of resources.filter((candidate) =>
  ["Role", "ClusterRole"].includes(candidate.kind),
)) {
  for (const rule of resource.rules ?? []) {
    assert.equal(rule.apiGroups?.includes("*"), false, `${resource.kind} uses wildcard apiGroups`);
    assert.equal(rule.resources?.includes("*"), false, `${resource.kind} uses wildcard resources`);
    assert.equal(rule.verbs?.includes("*"), false, `${resource.kind} uses wildcard verbs`);
    assert.equal(rule.resources?.includes("secrets"), false, `${resource.kind} can read Secrets`);
    assert.equal(rule.resources?.includes("nodes"), false, `${resource.kind} can read Nodes`);
  }
}
const runtimeReader = find("ClusterRole", "agent-dock-sandbox-manager-runtimeclass-reader");
assert.deepEqual(runtimeReader.rules, [
  {
    apiGroups: ["node.k8s.io"],
    resources: ["runtimeclasses"],
    resourceNames: ["agent-dock-gvisor"],
    verbs: ["get"],
  },
]);

for (const namespace of ["agent-dock-sandboxes", "agent-dock-importers", "agent-dock-egress"]) {
  const deny = find("NetworkPolicy", "agent-dock-default-deny-all", namespace);
  assert.deepEqual(deny.spec.podSelector, {});
  assert.deepEqual(new Set(deny.spec.policyTypes), new Set(["Ingress", "Egress"]));
  assert.equal("ingress" in deny.spec, false);
  assert.equal("egress" in deny.spec, false);
}
const publicEgress = find("NetworkPolicy", "dependency-egress-public-https", "agent-dock-egress");
const publicRule = publicEgress.spec.egress.find((rule) => rule.to?.[0]?.ipBlock !== undefined);
assert.equal(publicRule.ports[0].port, 443);
for (const blocked of [
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
]) {
  assert.equal(
    publicRule.to[0].ipBlock.except.includes(blocked),
    true,
    `${blocked} must be blocked`,
  );
}
const importerPolicy = find(
  "NetworkPolicy",
  "repository-import-public-https",
  "agent-dock-importers",
);
assert.equal(importerPolicy.spec.egress.length, 1);
assert.equal(importerPolicy.spec.egress[0].ports[0].port, 3128);

const deployment = find("Deployment", "dependency-egress-proxy", "agent-dock-egress");
assert.equal(deployment.spec.replicas, 2);
assert.equal(deployment.spec.strategy.type, "RollingUpdate");
assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
assert.equal(deployment.spec.strategy.rollingUpdate.maxSurge, 1);
const podSpec = deployment.spec.template.spec;
assert.equal(podSpec.automountServiceAccountToken, false);
assert.equal(podSpec.enableServiceLinks, false);
assert.equal(podSpec.hostIPC, false);
assert.equal(podSpec.hostNetwork, false);
assert.equal(podSpec.hostPID, false);
assert.equal(
  podSpec.runtimeClassName,
  undefined,
  "The trusted proxy must not impersonate a Tool Pod",
);
assert.equal(podSpec.containers.length, 1);
assert.equal(
  podSpec.volumes.some((volume) => volume.hostPath !== undefined),
  false,
);
const proxy = podSpec.containers[0];
assert.equal(proxy.securityContext.allowPrivilegeEscalation, false);
assert.equal(proxy.securityContext.privileged, false);
assert.equal(proxy.securityContext.readOnlyRootFilesystem, true);
assert.deepEqual(proxy.securityContext.capabilities.drop, ["ALL"]);
assert.ok(proxy.resources.requests.cpu);
assert.ok(proxy.resources.requests.memory);
assert.ok(proxy.resources.limits.cpu);
assert.ok(proxy.resources.limits.memory);
const service = find("Service", "dependency-egress-proxy", "agent-dock-egress");
assert.equal(service.spec.type, "ClusterIP");
assert.equal(service.spec.externalName, undefined);
assert.equal(service.spec.externalIPs, undefined);
assert.equal(service.spec.ports[0].nodePort, undefined);
const disruptionBudget = find(
  "PodDisruptionBudget",
  "dependency-egress-proxy",
  "agent-dock-egress",
);
assert.equal(disruptionBudget.spec.minAvailable, 1);

assert.equal(
  resources.some((resource) => ["Ingress", "Gateway", "HTTPRoute"].includes(resource.kind)),
  false,
  "Execution plane must not expose an ingress resource",
);
assert.equal(
  resources.some((resource) => /runner|supervisor/i.test(`${resource.metadata?.name ?? ""}`)),
  false,
  "The outbound Runner must not be deployed or exposed by this chart",
);

for (const invalidArgs of [
  ["--set", "dependencyEgressProxy.replicas=1"],
  ["--set", "dependencyEgressProxy.rollingUpdate.maxUnavailable=1"],
  ["--set", "unexpectedPolicyEscape=true"],
]) {
  const result = command(helm, ["lint", chart, "--strict", ...invalidArgs]);
  assert.notEqual(result.status, 0, `Schema unexpectedly accepted ${invalidArgs.at(-1)}`);
}

const upgradeRender = requireSuccess(
  command(helm, [
    "template",
    "agent-dock-execution-plane",
    chart,
    "--set",
    "dependencyEgressProxy.replicas=3",
    "--set",
    "dependencyEgressProxy.image.tag=next",
  ]),
  "Helm rolling-upgrade render",
);
assert.match(upgradeRender, /replicas: 3/);
assert.match(upgradeRender, /agent-dock\/dependency-egress-proxy:next/);
assert.match(upgradeRender, /maxUnavailable: 0/);

console.log("helm_execution_plane_check_passed");
