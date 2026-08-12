import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = resolve(repositoryRoot, "deploy/helm/agent-dock-platform");

function fail(message) {
  throw new Error(`AgentDock enterprise Cells: ${message}`);
}

function run(binary, args, inherit = false) {
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0) {
    if (!inherit) {
      process.stderr.write(result.stderr ?? "");
      process.stderr.write(result.stdout ?? "");
    }
    fail(`${binary} ${args[0] ?? ""} failed`);
  }
  return result.stdout ?? "";
}

function optional(binary, args) {
  return spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function mapping(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be a mapping`);
  }
  return value;
}

function boundedString(value, name, pattern) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !pattern.test(value)) {
    fail(`${name} is invalid`);
  }
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function loadYaml(path, name) {
  if (!existsSync(path)) fail(`${name} does not exist: ${path}`);
  return mapping(parse(readFileSync(path, "utf8")), name);
}

function mergeValues(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergeValues(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function loadProfile(path) {
  const document = loadYaml(path, "profile");
  if (
    document.apiVersion !== "agent-dock.io/v1alpha1" ||
    document.kind !== "EnterpriseCellProfile"
  ) {
    fail("profile apiVersion/kind is unsupported");
  }
  const metadata = mapping(document.metadata, "metadata");
  const spec = mapping(document.spec, "spec");
  const name = boundedString(metadata.name, "metadata.name", /^[a-z0-9][a-z0-9-]*$/u);
  const baseValues = resolve(
    repositoryRoot,
    boundedString(spec.baseValues, "spec.baseValues", /^[A-Za-z0-9._/-]+$/u),
  );
  const globalNamespace = boundedString(
    spec.globalNamespace,
    "spec.globalNamespace",
    /^[a-z0-9][a-z0-9-]*$/u,
  );
  const globalRelease = boundedString(
    spec.globalRelease,
    "spec.globalRelease",
    /^[a-z0-9][a-z0-9-]*$/u,
  );
  const cellNamespacePrefix = boundedString(
    spec.cellNamespacePrefix,
    "spec.cellNamespacePrefix",
    /^[a-z0-9][a-z0-9-]*-$/u,
  );
  const cellReleasePrefix = boundedString(
    spec.cellReleasePrefix,
    "spec.cellReleasePrefix",
    /^[a-z0-9][a-z0-9-]*-$/u,
  );
  const sandboxDomainNamespace = boundedString(
    spec.sandboxDomainNamespace,
    "spec.sandboxDomainNamespace",
    /^[a-z0-9][a-z0-9-]*$/u,
  );
  const sandboxDomainRelease = boundedString(
    spec.sandboxDomainRelease,
    "spec.sandboxDomainRelease",
    /^[a-z0-9][a-z0-9-]*$/u,
  );
  const sandboxDomainId = boundedString(
    spec.sandboxDomainId,
    "spec.sandboxDomainId",
    /^sandbox-domain-[a-z0-9][a-z0-9-]*$/u,
  );
  const clusterDomain = boundedString(spec.clusterDomain, "spec.clusterDomain", /^[a-z0-9.-]+$/u);
  return {
    name,
    baseValues,
    globalNamespace,
    globalRelease,
    cellNamespacePrefix,
    cellReleasePrefix,
    sandboxDomainNamespace,
    sandboxDomainRelease,
    sandboxDomainId,
    clusterDomain,
    cubeApiUrl: boundedString(spec.cubeApiUrl, "spec.cubeApiUrl", /^https:\/\/[^\s]+$/u),
    cubeProxyNodeIp: boundedString(
      spec.cubeProxyNodeIp,
      "spec.cubeProxyNodeIp",
      /^[A-Za-z0-9.-]+$/u,
    ),
    cubeDomain: boundedString(spec.cubeDomain, "spec.cubeDomain", /^[A-Za-z0-9.-]+$/u),
    cellCount: integer(spec.cellCount, "spec.cellCount", 1, 64),
    workerCapacity: integer(spec.workerCapacity, "spec.workerCapacity", 1, 64),
    minimumWorkersPerCell: integer(
      spec.minimumWorkersPerCell,
      "spec.minimumWorkersPerCell",
      1,
      256,
    ),
    maximumWorkersPerCell: integer(
      spec.maximumWorkersPerCell,
      "spec.maximumWorkersPerCell",
      1,
      256,
    ),
    toolBrokerReplicas: integer(spec.toolBrokerReplicas, "spec.toolBrokerReplicas", 1, 16),
    dataMoverReplicas: integer(spec.dataMoverReplicas, "spec.dataMoverReplicas", 1, 16),
    toolBrokerMaximumActivePerReplica: integer(
      spec.toolBrokerMaximumActivePerReplica,
      "spec.toolBrokerMaximumActivePerReplica",
      1,
      4096,
    ),
    maximumActiveSandboxes: integer(
      spec.maximumActiveSandboxes,
      "spec.maximumActiveSandboxes",
      1,
      1_000_000,
    ),
    controlPlaneMaximumReplicas: integer(
      spec.controlPlaneMaximumReplicas,
      "spec.controlPlaneMaximumReplicas",
      3,
      256,
    ),
    eventGatewayMaximumReplicas: integer(
      spec.eventGatewayMaximumReplicas,
      "spec.eventGatewayMaximumReplicas",
      3,
      512,
    ),
  };
}

function cellNumber(index) {
  return String(index + 1).padStart(4, "0");
}

function cellDescriptor(profile, index) {
  const suffix = cellNumber(index);
  const id = `cell-${suffix}`;
  const namespace = `${profile.cellNamespacePrefix}${suffix}`;
  const workerPoolName = `${id}-v1`;
  return {
    id,
    namespace,
    release: `${profile.cellReleasePrefix}${suffix}`,
    workerPoolName,
    displayName: `Execution Cell ${suffix}`,
    state: "active",
    temporalTaskQueue: `agent-dock-pi-runs-${id}-v1`,
    sandboxDomainId: profile.sandboxDomainId,
    supervisorManagementBaseUrlTemplate: `http://{supervisorId}.agent-dock-pi-worker-${workerPoolName}.${namespace}.svc.${profile.clusterDomain}:4100`,
    capacityWeight: 100,
  };
}

function buildTopology(profile) {
  if (profile.minimumWorkersPerCell > profile.maximumWorkersPerCell) {
    fail("minimumWorkersPerCell cannot exceed maximumWorkersPerCell");
  }
  const cells = Array.from({ length: profile.cellCount }, (_, index) =>
    cellDescriptor(profile, index),
  );
  const maximumRunSlots =
    profile.cellCount * profile.maximumWorkersPerCell * profile.workerCapacity;
  const maximumSandboxAdmissions = profile.maximumActiveSandboxes;
  if (maximumSandboxAdmissions < maximumRunSlots) {
    fail(
      `Sandbox admission capacity ${maximumSandboxAdmissions} is below Worker slot capacity ${maximumRunSlots}`,
    );
  }
  const domain = {
    id: profile.sandboxDomainId,
    displayName: "Primary Sandbox Domain",
    state: "active",
    toolBrokerBaseUrl: `http://tool-broker.${profile.sandboxDomainNamespace}.svc.${profile.clusterDomain}:4300`,
    workspaceStorageKey: "workspace-domain-0001",
    maximumActiveSandboxes: profile.maximumActiveSandboxes,
  };
  return { cells, domain, maximumRunSlots, maximumSandboxAdmissions };
}

function globalValues(base, profile, topology) {
  const values = structuredClone(base);
  values.globalPlaneEnabled = true;
  values.sandboxPlaneEnabled = false;
  values.piWorkersEnabled = false;
  values.executionCells = topology.cells.map(
    ({ namespace, release, workerPoolName, ...cell }) => cell,
  );
  values.sandboxDomains = [topology.domain];
  values.global.clusterDomain = profile.clusterDomain;
  values.controlPlane.autoscaling.enabled = true;
  values.controlPlane.autoscaling.maxReplicas = profile.controlPlaneMaximumReplicas;
  values.eventGateway.autoscaling.enabled = true;
  values.eventGateway.autoscaling.maxReplicas = profile.eventGatewayMaximumReplicas;
  values.external.temporal.taskQueue = topology.cells[0].temporalTaskQueue;
  return values;
}

function domainValues(base, profile, topology) {
  const values = structuredClone(base);
  values.globalPlaneEnabled = false;
  values.sandboxPlaneEnabled = true;
  values.piWorkersEnabled = false;
  values.bootstrap.enabled = false;
  values.executionCells = topology.cells.map(
    ({ namespace, release, workerPoolName, ...cell }) => cell,
  );
  values.sandboxDomains = [topology.domain];
  values.global.clusterDomain = profile.clusterDomain;
  values.sandboxPlane.domainId = profile.sandboxDomainId;
  values.sandboxPlane.toolBrokerReplicas = profile.toolBrokerReplicas;
  values.sandboxPlane.dataMoverReplicas = profile.dataMoverReplicas;
  values.sandboxPlane.cube.apiUrl = profile.cubeApiUrl;
  values.sandboxPlane.cube.proxyNodeIp = profile.cubeProxyNodeIp;
  values.sandboxPlane.cube.domain = profile.cubeDomain;
  values.sandboxPlane.maximumActivePerReplica = profile.toolBrokerMaximumActivePerReplica;
  return values;
}

function cellValues(base, profile, topology, cell) {
  const values = structuredClone(base);
  values.globalPlaneEnabled = false;
  values.sandboxPlaneEnabled = false;
  values.piWorkersEnabled = true;
  values.bootstrap.enabled = false;
  values.executionCells = [
    Object.fromEntries(
      Object.entries(cell).filter(
        ([key]) => !["namespace", "release", "workerPoolName"].includes(key),
      ),
    ),
  ];
  values.sandboxDomains = [topology.domain];
  values.global.clusterDomain = profile.clusterDomain;
  values["pi-workers"].workerPool.name = cell.workerPoolName;
  values["pi-workers"].workerPool.replicas = profile.minimumWorkersPerCell;
  values["pi-workers"].workerPool.capacity = profile.workerCapacity;
  values["pi-workers"].workerPool.executionCellId = cell.id;
  values["pi-workers"].workerPool.clusterDomain = profile.clusterDomain;
  values["pi-workers"].autoscaling.enabled = true;
  values["pi-workers"].autoscaling.minReplicas = profile.minimumWorkersPerCell;
  values["pi-workers"].autoscaling.maxReplicas = profile.maximumWorkersPerCell;
  values["pi-workers"].temporal.taskQueue = cell.temporalTaskQueue;
  values["pi-workers"].temporal.workerDeploymentName = `agent-dock-pi-workers-${cell.id}`;
  values["pi-workers"].services.controlPlaneUrl =
    `http://control-plane.${profile.globalNamespace}.svc.${profile.clusterDomain}:3000`;
  values["pi-workers"].services.toolBrokerUrls = [topology.domain.toolBrokerBaseUrl];
  return values;
}

function withTemporaryValues(documents, operation) {
  const root = mkdtempSync(resolve(tmpdir(), "agent-dock-enterprise-cells-"));
  try {
    const paths = documents.map((document, index) => {
      const path = resolve(root, `${String(index).padStart(3, "0")}.yaml`);
      writeFileSync(path, stringify(document), { mode: 0o600 });
      return path;
    });
    return operation(paths);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function helmTemplate(release, namespace, valuesPath) {
  return run("helm", [
    "template",
    release,
    chart,
    "--namespace",
    namespace,
    "--values",
    valuesPath,
  ]);
}

function ensureNamespace(namespace, cellId) {
  if (optional("kubectl", ["get", "namespace", namespace]).status !== 0) {
    run("kubectl", ["create", "namespace", namespace], true);
  }
  const labels = ["agent-dock.io/trusted-plane=true"];
  if (cellId !== undefined) labels.push(`agent-dock.io/execution-cell=${cellId}`);
  run("kubectl", ["label", "namespace", namespace, ...labels, "--overwrite"], true);
}

const requiredSecretKeys = [
  "api-token",
  "aws-credentials",
  "cube-egress-config-token",
  "cubesandbox-api-key",
  "database-notification-url",
  "database-url",
  "metrics-token",
  "model-credential-master-key",
  "tool-broker-token",
  "sandbox-materializer-token",
  "supervisor-enrollment-token",
  "supervisor-management-token",
  "worker-event-ingest-token",
  "live-event-store-url",
  "workspace-data-mover-token",
  "workspace-kopia-aws-credentials",
  "workspace-kopia-repository-password",
];
const globalEventSecretKeys = ["kafka-ca.crt", "kafka-username", "kafka-password"];

function verifyNamespaceAuthorities(namespace, values, requireWorkspace, extraSecretKeys = []) {
  const secretName = values.global.existingSecret;
  const result = optional("kubectl", ["get", "secret", secretName, "-n", namespace, "-o", "json"]);
  if (result.status !== 0) fail(`Secret ${namespace}/${secretName} is unavailable`);
  const secret = JSON.parse(result.stdout);
  for (const key of [...requiredSecretKeys, ...extraSecretKeys]) {
    if (typeof secret.data?.[key] !== "string") {
      fail(`Secret ${namespace}/${secretName} is missing ${key}`);
    }
  }
  if (!requireWorkspace) return;
  const claimName = values.sandboxPlane.workspace.existingClaim;
  const claimResult = optional("kubectl", ["get", "pvc", claimName, "-n", namespace, "-o", "json"]);
  if (claimResult.status !== 0) fail(`PVC ${namespace}/${claimName} is unavailable`);
  const claim = JSON.parse(claimResult.stdout);
  if (!claim.spec?.accessModes?.includes("ReadWriteMany")) {
    fail(`PVC ${namespace}/${claimName} must support ReadWriteMany`);
  }
}

function preflight(profile, topology, base) {
  if (optional("kubectl", ["version", "--client"]).status !== 0) fail("kubectl is required");
  if (optional("helm", ["version", "--short"]).status !== 0) fail("Helm 3 is required");
  run("kubectl", ["cluster-info"]);
  if (optional("kubectl", ["get", "crd", "scaledobjects.keda.sh"]).status !== 0) {
    fail("KEDA is required for Temporal Task Queue autoscaling");
  }
  if (optional("kubectl", ["get", "apiservice", "v1beta1.metrics.k8s.io"]).status !== 0) {
    fail("Kubernetes Metrics API is required for global-plane HPAs");
  }
  const kafkaBroker = base.external.kafka.brokers[0];
  const kafkaHost = kafkaBroker.replace(/:\d+$/, "");
  const serviceMatch = /^([a-z0-9-]+)\.([a-z0-9-]+)\.svc(?:\.|$)/.exec(kafkaHost);
  if (serviceMatch !== null) {
    const [, serviceName, namespace] = serviceMatch;
    const endpoints = optional("kubectl", [
      "get",
      "endpoints",
      serviceName,
      "-n",
      namespace,
      "-o",
      "json",
    ]);
    if (endpoints.status !== 0) fail(`Kafka Service ${namespace}/${serviceName} is unavailable`);
    const endpoint = JSON.parse(endpoints.stdout);
    if (!endpoint.subsets?.some((subset) => (subset.addresses?.length ?? 0) > 0)) {
      fail(`Kafka Service ${namespace}/${serviceName} has no Ready endpoint`);
    }
  }
  ensureNamespace(profile.globalNamespace);
  verifyNamespaceAuthorities(
    profile.globalNamespace,
    base,
    false,
    base.external.kafka.security.enabled ? globalEventSecretKeys : [],
  );
  ensureNamespace(profile.sandboxDomainNamespace);
  verifyNamespaceAuthorities(profile.sandboxDomainNamespace, base, true);
  for (const cell of topology.cells) {
    ensureNamespace(cell.namespace, cell.id);
    verifyNamespaceAuthorities(cell.namespace, base, false);
  }
}

function upgrade(release, namespace, valuesPath) {
  run(
    "helm",
    [
      "upgrade",
      "--install",
      release,
      chart,
      "--namespace",
      namespace,
      "--values",
      valuesPath,
      "--atomic",
      "--wait",
      "--timeout",
      "30m",
    ],
    true,
  );
}

function summary(profile, topology) {
  return {
    profile: profile.name,
    cells: topology.cells.length,
    workerCapacity: profile.workerCapacity,
    maximumWorkersPerCell: profile.maximumWorkersPerCell,
    maximumRunSlots: topology.maximumRunSlots,
    maximumSandboxAdmissions: topology.maximumSandboxAdmissions,
    sandboxDomains: 1,
    toolBrokerReplicas: profile.toolBrokerReplicas,
    dataMoverReplicas: profile.dataMoverReplicas,
  };
}

function help() {
  process.stdout.write(`Usage:
  node scripts/enterprise-cells.mjs render --profile <file> [--values <file>]
  node scripts/enterprise-cells.mjs preflight --profile <file> [--values <file>]
  node scripts/enterprise-cells.mjs deploy --profile <file> [--values <file>]
  node scripts/enterprise-cells.mjs status --profile <file>
  node scripts/enterprise-cells.mjs describe --profile <file>
`);
}

try {
  const action = process.argv[2] ?? "help";
  if (["help", "--help", "-h"].includes(action)) {
    help();
    process.exit(0);
  }
  const profileArgument = argument("--profile");
  if (profileArgument === "") fail("--profile <file> is required");
  const profile = loadProfile(resolve(process.cwd(), profileArgument));
  const topology = buildTopology(profile);
  if (action === "describe") {
    process.stdout.write(`${JSON.stringify(summary(profile, topology), null, 2)}\n`);
    process.exit(0);
  }
  if (action === "status") {
    run("helm", ["status", profile.globalRelease, "-n", profile.globalNamespace], true);
    run(
      "helm",
      ["status", profile.sandboxDomainRelease, "-n", profile.sandboxDomainNamespace],
      true,
    );
    for (const cell of topology.cells) {
      run("helm", ["status", cell.release, "-n", cell.namespace], true);
    }
    process.exit(0);
  }
  const valuesArgument = argument("--values");
  const valuesPath =
    valuesArgument === "" ? profile.baseValues : resolve(process.cwd(), valuesArgument);
  const defaults = loadYaml(resolve(chart, "values.yaml"), "chart defaults");
  const base = mergeValues(defaults, loadYaml(valuesPath, "base values"));
  run("helm", ["dependency", "build", chart]);
  const global = globalValues(base, profile, topology);
  const domain = domainValues(base, profile, topology);
  const cellDocuments = topology.cells.map((cell) => cellValues(base, profile, topology, cell));
  if (action === "render") {
    withTemporaryValues([global, domain, ...cellDocuments], (paths) => {
      process.stdout.write(
        `# agent-dock-enterprise-summary: ${JSON.stringify(summary(profile, topology))}\n`,
      );
      process.stdout.write(helmTemplate(profile.globalRelease, profile.globalNamespace, paths[0]));
      process.stdout.write("\n---\n");
      process.stdout.write(
        helmTemplate(profile.sandboxDomainRelease, profile.sandboxDomainNamespace, paths[1]),
      );
      topology.cells.forEach((cell, index) => {
        process.stdout.write("\n---\n");
        process.stdout.write(helmTemplate(cell.release, cell.namespace, paths[index + 2]));
      });
    });
    process.exit(0);
  }
  if (action !== "preflight" && action !== "deploy") fail(`unknown action: ${action}`);
  preflight(profile, topology, base);
  if (action === "preflight") {
    process.stdout.write(`${JSON.stringify(summary(profile, topology))}\n`);
    process.exit(0);
  }
  withTemporaryValues([global, domain, ...cellDocuments], (paths) => {
    upgrade(profile.sandboxDomainRelease, profile.sandboxDomainNamespace, paths[1]);
    upgrade(profile.globalRelease, profile.globalNamespace, paths[0]);
    topology.cells.forEach((cell, index) =>
      upgrade(cell.release, cell.namespace, paths[index + 2]),
    );
  });
  process.stdout.write(`${JSON.stringify(summary(profile, topology))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
