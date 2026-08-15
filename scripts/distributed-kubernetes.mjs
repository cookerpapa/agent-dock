import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = resolve(repositoryRoot, "deploy/helm/agent-dock-platform");

function fail(message) {
  process.stderr.write(`AgentDock distributed deployment: ${message}\n`);
  process.exit(1);
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0) {
    if (!options.inherit) {
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

function argument(name, fallback) {
  const position = process.argv.indexOf(name);
  if (position < 0) return fallback;
  const value = process.argv[position + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function requireBinary(binary) {
  if (optional(binary, ["version", "--client"]).status !== 0 && binary === "kubectl") {
    fail("kubectl is required");
  }
  if (optional(binary, ["version", "--short"]).status !== 0 && binary === "helm") {
    fail("Helm 3 is required");
  }
}

function loadValues(path) {
  if (!existsSync(path)) fail(`values file does not exist: ${path}`);
  const values = parse(readFileSync(path, "utf8"));
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    fail("values file must contain a YAML mapping");
  }
  return values;
}

function ensureNamespace(namespace) {
  if (optional("kubectl", ["get", "namespace", namespace]).status !== 0) {
    run("kubectl", ["create", "namespace", namespace], { inherit: true });
  }
  run(
    "kubectl",
    ["label", "namespace", namespace, "agent-dock.io/trusted-plane=true", "--overwrite"],
    { inherit: true },
  );
}

function preflight(namespace, values) {
  requireBinary("kubectl");
  requireBinary("helm");
  run("kubectl", ["cluster-info"]);
  const nodes = JSON.parse(run("kubectl", ["get", "nodes", "-o", "json"]));
  const readyNodes = nodes.items.filter(
    (node) =>
      node.spec?.unschedulable !== true &&
      node.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ),
  );
  if (readyNodes.length < 2 && process.env.AGENT_DOCK_ALLOW_SINGLE_NODE_DISTRIBUTED !== "1") {
    fail(
      "at least two Ready schedulable nodes are required; set AGENT_DOCK_ALLOW_SINGLE_NODE_DISTRIBUTED=1 only for a non-HA test cluster",
    );
  }
  if (optional("kubectl", ["get", "crd", "scaledobjects.keda.sh"]).status !== 0) {
    fail("KEDA is required because Pi Workers scale from the PostgreSQL Run backlog");
  }
  if (optional("kubectl", ["get", "apiservice", "v1beta1.metrics.k8s.io"]).status !== 0) {
    fail("Kubernetes Metrics API is required by the Web and Control Plane HPAs");
  }
  const secretName = values.global?.existingSecret;
  const workspaceClaim = values.sandboxPlane?.workspace?.existingClaim;
  if (typeof secretName !== "string" || secretName.length === 0) {
    fail("global.existingSecret is required");
  }
  if (typeof workspaceClaim !== "string" || workspaceClaim.length === 0) {
    fail("sandboxPlane.workspace.existingClaim is required");
  }
  const secret = JSON.parse(
    run("kubectl", ["get", "secret", secretName, "-n", namespace, "-o", "json"]),
  );
  const requiredSecretKeys = [
    "api-token",
    "cube-egress-config-token",
    "cubesandbox-api-key",
    "database-notification-url",
    "database-url",
    "metrics-token",
    "model-credential-master-key",
    "tool-broker-token",
    "sandbox-materializer-token",
    "workspace-terminal-token",
    "supervisor-enrollment-token",
    "supervisor-management-token",
    "worker-event-ingest-token",
    "live-event-store-url",
    "workspace-volume-gateway-token",
    "kafka-ca.crt",
    "kafka-username",
    "kafka-password",
  ];
  for (const key of requiredSecretKeys) {
    if (typeof secret.data?.[key] !== "string") fail(`Secret ${secretName} is missing key ${key}`);
  }
  const claim = JSON.parse(
    run("kubectl", ["get", "pvc", workspaceClaim, "-n", namespace, "-o", "json"]),
  );
  if (!claim.spec?.accessModes?.includes("ReadWriteMany")) {
    fail(`PVC ${workspaceClaim} must support ReadWriteMany for distributed Volume Gateways`);
  }
  process.stdout.write(
    `Distributed preflight passed: ${readyNodes.length} Ready nodes, external authorities and shared workspace contract present.\n`,
  );
}

const action = process.argv[2] ?? "help";
const namespace = argument("--namespace", "agent-dock-system");
const release = argument("--release", "agent-dock");
const configuredValues = argument("--values", "");
const valuesPath = configuredValues === "" ? "" : resolve(process.cwd(), configuredValues);

if (action === "help" || action === "--help" || action === "-h") {
  process.stdout.write(`Usage:
  node scripts/distributed-kubernetes.mjs render --values <file>
  node scripts/distributed-kubernetes.mjs preflight --values <file> [--namespace <name>]
  node scripts/distributed-kubernetes.mjs deploy --values <file> [--namespace <name>] [--release <name>]
  node scripts/distributed-kubernetes.mjs status [--namespace <name>] [--release <name>]
`);
  process.exit(0);
}

if (action === "status") {
  requireBinary("kubectl");
  requireBinary("helm");
  run("helm", ["status", release, "--namespace", namespace], { inherit: true });
  run(
    "kubectl",
    [
      "get",
      "deploy,statefulset,pod,hpa,scaledobject,pvc",
      "--namespace",
      namespace,
      "-l",
      `app.kubernetes.io/instance=${release}`,
      "-o",
      "wide",
    ],
    { inherit: true },
  );
  process.exit(0);
}

if (valuesPath === "") fail("--values <file> is required");
const values = loadValues(valuesPath);
requireBinary("helm");
run("helm", ["dependency", "build", chart]);

if (action === "render") {
  run("helm", ["template", release, chart, "--namespace", namespace, "--values", valuesPath], {
    inherit: true,
  });
  process.exit(0);
}

if (action !== "preflight" && action !== "deploy") fail(`unknown action: ${action}`);
ensureNamespace(namespace);
preflight(namespace, values);
if (action === "deploy") {
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
    { inherit: true },
  );
  process.stdout.write(`AgentDock distributed release ${release} is ready.\n`);
}
