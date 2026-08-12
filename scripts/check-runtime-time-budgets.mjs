import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAllDocuments, parseDocument } from "yaml";

const MAX_TOOL_EXECUTION_MS = 5 * 60_000;
const TOOL_TRANSPORT_MARGIN_MS = 60_000;
const MODEL_CAPABILITY_MARGIN_MS = 60_000;
const TEMPORAL_SETTLEMENT_GRACE_MS = 5 * 60_000;
const PROCESS_SHUTDOWN_MARGIN_MS = 60_000;
const LIVE_STREAM_RETENTION_MS = 60 * 60_000;

function integer(value, description) {
  const parsed = Number(value);
  assert.ok(
    Number.isSafeInteger(parsed) && parsed > 0,
    `${description} must be a positive integer`,
  );
  return parsed;
}

function durationMs(value, description) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(value));
  assert.ok(match, `${description} must use one bounded duration unit`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return integer(match[1], description) * factors[match[2]];
}

function validateWorkerPolicy(policy, description) {
  const manager = integer(policy.toolBrokerRequestMs, `${description} Tool Broker timeout`);
  const capability = integer(policy.modelCapabilityTtlMs, `${description} model capability TTL`);
  const upstream = integer(policy.modelUpstreamRequestMs, `${description} upstream timeout`);
  const model = integer(policy.modelRequestMs, `${description} Pi model timeout`);
  const turn = integer(policy.turnMs, `${description} Pi Turn timeout`);
  const termination = integer(policy.terminationGraceMs, `${description} termination grace`);

  assert.ok(
    manager >= MAX_TOOL_EXECUTION_MS + TOOL_TRANSPORT_MARGIN_MS,
    `${description} can time out before a maximum Tool result is returned`,
  );
  assert.ok(upstream <= model, `${description} Pi may time out before its model gateway`);
  assert.ok(model <= turn, `${description} Turn may time out before one model request`);
  assert.ok(
    capability >= turn + MODEL_CAPABILITY_MARGIN_MS,
    `${description} model capability can expire before its Turn boundary`,
  );
  assert.ok(
    termination >= turn + manager + TEMPORAL_SETTLEMENT_GRACE_MS + PROCESS_SHUTDOWN_MARGIN_MS,
    `${description} process can be killed before its Temporal Activity drain completes`,
  );
}

const composeText = readFileSync("deploy/production/compose.yaml", "utf8");
const composeWorker = composeText.slice(
  composeText.indexOf("\n  supervisor-host:"),
  composeText.indexOf("\n  supervisor-host-1:"),
);
assert.ok(composeWorker.length > 0, "Compose Pi Worker service is missing");
function composeInteger(name) {
  const match = new RegExp(`${name}: [\"']?(\\d+)[\"']?`).exec(composeWorker);
  assert.ok(match, `Compose ${name} is missing`);
  return integer(match[1], `Compose ${name}`);
}
const composeStop = /stop_grace_period:\s*(\S+)/.exec(composeWorker)?.[1];
assert.ok(composeStop, "Compose Pi Worker stop grace is missing");
validateWorkerPolicy(
  {
    toolBrokerRequestMs: composeInteger("AGENT_DOCK_TOOL_BROKER_REQUEST_TIMEOUT_MS"),
    modelCapabilityTtlMs: composeInteger("AGENT_DOCK_MODEL_GATEWAY_CAPABILITY_TTL_MS"),
    modelUpstreamRequestMs: composeInteger("AGENT_DOCK_MODEL_GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS"),
    modelRequestMs: composeInteger("AGENT_DOCK_PI_MODEL_REQUEST_TIMEOUT_MS"),
    turnMs: composeInteger("AGENT_DOCK_PI_TURN_TIMEOUT_MS"),
    terminationGraceMs: durationMs(composeStop, "Compose Pi Worker stop grace"),
  },
  "Compose Pi Worker",
);

function yaml(path) {
  const document = parseDocument(readFileSync(path, "utf8"));
  assert.equal(document.errors.length, 0, `${path} is invalid YAML`);
  return document.toJSON();
}

const workerValues = yaml("deploy/helm/agent-dock-pi-worker-pool/values.yaml");
validateWorkerPolicy(
  {
    ...workerValues.runtime.timeouts,
    terminationGraceMs: workerValues.lifecycle.terminationGracePeriodSeconds * 1_000,
  },
  "Pi Worker Helm chart",
);
const platformValues = yaml("deploy/helm/agent-dock-platform/values.yaml");
validateWorkerPolicy(
  {
    ...platformValues["pi-workers"].runtime.timeouts,
    terminationGraceMs:
      platformValues["pi-workers"].lifecycle.terminationGracePeriodSeconds * 1_000,
  },
  "Platform Helm chart",
);

const composeKafkaRetention =
  /retention_ms=\$\{AGENT_DOCK_WORKER_EVENT_RETENTION_MS:-([0-9]+)\}/.exec(composeText)?.[1];
assert.ok(composeKafkaRetention, "Compose Kafka retention default is missing");
assert.ok(
  integer(composeKafkaRetention, "Compose Kafka retention") > LIVE_STREAM_RETENTION_MS,
  "Compose Kafka retention must outlive the Valkey replay window",
);

const enterpriseKafka = parseAllDocuments(
  readFileSync("deploy/enterprise/kafka/cluster.yaml", "utf8"),
)
  .map((document) => document.toJSON())
  .find(
    (resource) =>
      resource?.kind === "KafkaTopic" && resource.metadata?.name === "agent-dock-worker-events-v1",
  );
assert.ok(enterpriseKafka, "Enterprise Worker-event Kafka topic is missing");
assert.ok(
  integer(enterpriseKafka.spec.config["retention.ms"], "Enterprise Kafka retention") >
    LIVE_STREAM_RETENTION_MS,
  "Enterprise Kafka retention must outlive the Valkey replay window",
);

process.stdout.write("runtime_time_budget_check_passed\n");
