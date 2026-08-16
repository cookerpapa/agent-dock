import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

function documents(path) {
  return parseAllDocuments(readFileSync(path, "utf8")).map((document, index) => {
    assert.equal(document.errors.length, 0, `${path} document ${index} is invalid`);
    return document.toJSON();
  });
}

const namespace = documents("deploy/enterprise/kafka/namespace.yaml")[0];
assert.equal(namespace.kind, "Namespace");
assert.equal(namespace.metadata.name, "pi-cloud-eventing");
assert.equal(namespace.metadata.labels["pi-cloud.io/trusted-plane"], "true");

const resources = documents("deploy/enterprise/kafka/cluster.yaml");
const find = (kind, name) => {
  const matches = resources.filter(
    (resource) => resource.kind === kind && resource.metadata?.name === name,
  );
  assert.equal(matches.length, 1, `${kind}/${name} must be unique`);
  return matches[0];
};
const controllers = find("KafkaNodePool", "controllers");
assert.equal(controllers.spec.replicas, 3);
assert.equal(controllers.spec.resources.requests.memory, "4Gi");
assert.equal(
  controllers.spec.template.pod.affinity.podAntiAffinity
    .requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey,
  "kubernetes.io/hostname",
);
const brokers = find("KafkaNodePool", "brokers");
assert.equal(brokers.spec.replicas, 6);
assert.equal(brokers.spec.storage.deleteClaim, false);
assert.equal(
  brokers.spec.template.pod.topologySpreadConstraints[0].topologyKey,
  "topology.kubernetes.io/zone",
);
const kafka = find("Kafka", "pi-cloud-kafka");
assert.equal(kafka.spec.kafka.rack.topologyKey, "topology.kubernetes.io/zone");
assert.equal(kafka.spec.kafka.config["min.insync.replicas"], 2);
assert.equal(kafka.spec.kafka.config["unclean.leader.election.enable"], false);
assert.equal(kafka.spec.kafka.listeners[0].port, 9093);
assert.equal(kafka.spec.kafka.listeners[0].tls, true);
assert.equal(kafka.spec.kafka.listeners[0].authentication.type, "scram-sha-512");
const topic = find("KafkaTopic", "pi-cloud-worker-events-v1");
assert.equal(topic.spec.partitions, 256);
assert.equal(topic.spec.replicas, 3);
assert.equal(topic.spec.config["min.insync.replicas"], 2);
const user = find("KafkaUser", "pi-cloud-event-gateway");
assert.equal(user.spec.authentication.type, "scram-sha-512");
assert.equal(user.spec.authorization.type, "simple");
assert.ok(
  user.spec.authorization.acls.some(
    (acl) => acl.resource.type === "cluster" && acl.operations.includes("IdempotentWrite"),
  ),
);

process.stdout.write("enterprise_kafka_check_passed\n");
