import { KafkaJS } from "@confluentinc/kafka-javascript";
import { createControlPlaneApplication } from "@pi-cloud/control-plane";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { EventGateway } from "@pi-cloud/event-gateway";
import type {
  AcceptedTurnResource,
  EventPublishBatchMessage,
  ProjectResource,
  SessionResource,
} from "@pi-cloud/protocol";
import { DurableEventStore } from "@pi-cloud/runtime-core/durable-event-store";
import { PostgresEventProjectionBarrier } from "@pi-cloud/runtime-core/event-projection-barrier";
import { HttpDurableEventIngestor } from "@pi-cloud/runtime-core/http-durable-event-ingestor";
import { commitTerminalTurnEvent } from "@pi-cloud/runtime-core/terminal-turn-event";
import {
  HttpTerminalTurnProjectionSource,
  LiveTerminalTurnProjectionSource,
} from "@pi-cloud/runtime-core/terminal-turn-projection";
import { ValkeyLiveSessionEventStore } from "@pi-cloud/runtime-core/live-session-event-store";
import {
  KafkaWorkerEventLog,
  KafkaWorkerEventProjector,
} from "@pi-cloud/runtime-core/worker-event-log";
import type {
  SessionEventNotification,
  SessionEventNotificationHandlers,
  SessionEventNotificationTransport,
} from "@pi-cloud/runtime-core/session-event-notifications";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";

const { Kafka, logLevel } = KafkaJS;
const databaseUrl = process.env.PI_CLOUD_TEST_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("PI_CLOUD_TEST_DATABASE_URL is required");
const brokers = (process.env.PI_CLOUD_KAFKA_BROKERS ?? "127.0.0.1:19092")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const reportPath =
  process.env.PI_CLOUD_ENTERPRISE_EVENT_REPORT ??
  "docs/reports/enterprise-event-pipeline-acceptance-latest.json";
const topic = `pi-cloud-enterprise-acceptance-${randomUUID()}`;
const groupId = `pi-cloud-enterprise-projector-${randomUUID()}`;
const serviceToken = `acceptance-${"a".repeat(48)}`;
const liveEventStoreUrl = process.env.PI_CLOUD_LIVE_EVENT_STORE_URL ?? "redis://127.0.0.1:16379";
const ids = {
  tenant: randomUUID(),
  user: randomUUID(),
  credential: randomUUID(),
  profile: randomUUID(),
  sandbox: randomUUID(),
  sandboxBoot: randomUUID(),
};

class NoopNotifications implements SessionEventNotificationTransport {
  start(_handlers: SessionEventNotificationHandlers): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  publish(
    _transaction: Transaction<Database>,
    _notification: SessionEventNotification,
  ): Promise<void> {
    return Promise.resolve();
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Enterprise event projection timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

const database = createDatabase({ connectionString: databaseUrl, maxConnections: 12 });
const kafka = new Kafka({
  kafkaJS: { brokers, clientId: "pi-cloud-enterprise-acceptance", logLevel: logLevel.NOTHING },
});
const admin = kafka.admin();
let application: Awaited<ReturnType<typeof createControlPlaneApplication>> | undefined;
let gateway: EventGateway | undefined;
let eventLog: KafkaWorkerEventLog | undefined;
let projector: KafkaWorkerEventProjector | undefined;
const liveEvents = new ValkeyLiveSessionEventStore({ url: liveEventStoreUrl });

try {
  await runMigrations(database, "up");
  await database
    .insertInto("tenants")
    .values({ id: ids.tenant, slug: `enterprise-acceptance-${ids.tenant.slice(0, 8)}` })
    .execute();
  await database
    .insertInto("users")
    .values({ id: ids.user, tenant_id: ids.tenant, display_name: "Enterprise Acceptance" })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: ids.credential,
      tenant_id: ids.tenant,
      provider: "pi-cloud-fake",
      kind: "brokered",
      secret_ref: "broker://acceptance/fake",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: ids.profile,
      tenant_id: ids.tenant,
      name: "acceptance",
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: ids.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .execute();
  await database
    .insertInto("tenant_runtime_policies")
    .values({
      tenant_id: ids.tenant,
      default_model_profile_id: ids.profile,
      maximum_projects: 10,
      maximum_sessions: 10,
      maximum_unsettled_turns: 10,
      maximum_concurrent_turns: 4,
    })
    .execute();

  application = await createControlPlaneApplication({
    database,
    tenantId: ids.tenant,
    defaultModelProfileId: ids.profile,
  });
  const http = application.getHttpAdapter().getInstance();
  const projectResponse = await http.inject({
    method: "POST",
    url: "/v1/projects",
    payload: { name: "Enterprise event acceptance" },
  });
  if (projectResponse.statusCode !== 201) throw new Error(projectResponse.body);
  const project = projectResponse.json() as ProjectResource;
  const sessionResponse = await http.inject({
    method: "POST",
    url: `/v1/projects/${project.projectId}/sessions`,
    payload: { workspaceId: project.workspaceId, title: "Kafka-first acceptance" },
  });
  if (sessionResponse.statusCode !== 201) throw new Error(sessionResponse.body);
  const session = sessionResponse.json() as SessionResource;
  const turnResponse = await http.inject({
    method: "POST",
    url: `/v1/sessions/${session.sessionId}/turns`,
    headers: { "idempotency-key": `acceptance-${randomUUID()}` },
    payload: { prompt: "Verify the enterprise event plane." },
  });
  if (turnResponse.statusCode !== 202) throw new Error(turnResponse.body);
  const accepted = turnResponse.json() as AcceptedTurnResource;
  const leaseId = randomUUID();
  const attemptId = randomUUID();
  const now = new Date();
  const validUntil = new Date(now.valueOf() + 10 * 60_000);
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("sandboxes")
      .values({
        id: ids.sandbox,
        supervisor_id: "enterprise-acceptance-worker",
        boot_id: ids.sandboxBoot,
        state: "leased",
        max_concurrent_sessions: 1,
        active_sessions: 1,
      })
      .execute();
    await transaction
      .insertInto("run_attempts")
      .values({
        id: attemptId,
        tenant_id: ids.tenant,
        run_id: accepted.runId,
        attempt_number: 1,
        state: "running",
        claim_owner_id: "enterprise-acceptance",
        claim_expires_at: validUntil,
        sandbox_id: ids.sandbox,
        lease_id: leaseId,
        fencing_token: 1,
        checkpoint_revision: null,
        failure_code: null,
        failure_message: null,
        failure_retryable: null,
        claimed_at: now,
        provisioning_at: now,
        restoring_at: now,
        running_at: now,
        checkpointing_at: null,
        last_heartbeat_at: now,
        settled_at: null,
      })
      .execute();
    await transaction
      .updateTable("runs")
      .set({
        state: "running",
        current_attempt_id: attemptId,
        attempt_count: 1,
        started_at: now,
        updated_at: now,
      })
      .where("id", "=", accepted.runId)
      .execute();
    await transaction
      .updateTable("commands")
      .set({ state: "acknowledged", dispatched_at: now, acknowledged_at: now })
      .where("id", "=", accepted.commandId)
      .execute();
    await transaction
      .updateTable("turns")
      .set({ state: "running", started_at: now })
      .where("id", "=", accepted.turnId)
      .execute();
    await transaction
      .updateTable("sessions")
      .set({ state: "running", last_fencing_token: 1 })
      .where("id", "=", session.sessionId)
      .execute();
    await transaction
      .updateTable("outbox")
      .set({ attempts: 1, published_at: now })
      .where(sql<boolean>`${sql.ref("payload")} ->> 'commandId' = ${accepted.commandId}`)
      .execute();
    await transaction
      .insertInto("session_leases")
      .values({
        session_id: session.sessionId,
        lease_id: leaseId,
        sandbox_id: ids.sandbox,
        fencing_token: 1,
        acquired_at: now,
        renewed_at: now,
        valid_until: validUntil,
      })
      .execute();
  });

  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 8, replicationFactor: 1 }] });
  eventLog = new KafkaWorkerEventLog({
    brokers,
    clientId: "pi-cloud-enterprise-ingest",
    topic,
  });
  const store = new DurableEventStore({
    database,
    workerEventLog: eventLog,
    liveEventStore: liveEvents,
  });
  projector = new KafkaWorkerEventProjector({
    brokers,
    clientId: "pi-cloud-enterprise-projector",
    topic,
    groupId,
    sink: store,
    partitionsConsumedConcurrently: 4,
  });
  gateway = new EventGateway({
    database,
    eventLog: store,
    apiAuthenticator: { authenticate: () => Promise.resolve(undefined) },
    webSessionAuthenticator: { authenticate: () => Promise.resolve(undefined) },
    notifications: new NoopNotifications(),
    workerEventIngestor: store,
    workerEventIngestToken: serviceToken,
    terminalTurnProjectionSource: new LiveTerminalTurnProjectionSource({ database, liveEvents }),
  });
  await projector.start();
  const address = await gateway.listen(0, "127.0.0.1");
  const ingest = new HttpDurableEventIngestor({
    baseUrl: address,
    serviceToken,
    allowInsecureHttp: true,
  });

  const publication = (
    firstSequence: number,
    texts: readonly string[],
  ): EventPublishBatchMessage => ({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: "event.publish_batch",
    payload: {
      commandId: accepted.commandId,
      leaseId,
      fencingToken: 1,
      events: texts.map((text, index) => ({
        schemaVersion: 1,
        eventId: randomUUID(),
        sessionId: session.sessionId,
        turnId: accepted.turnId,
        agentId: "root",
        seq: firstSequence + index,
        occurredAt: new Date().toISOString(),
        type: "assistant.text.delta" as const,
        payload: { text },
      })),
    },
  });

  const first = publication(1, ["Kafka ", "first"]);
  let unauthorizedRejected = false;
  try {
    await new HttpDurableEventIngestor({
      baseUrl: address,
      serviceToken: `invalid-${"z".repeat(48)}`,
      allowInsecureHttp: true,
    }).ingest(first);
  } catch (error: unknown) {
    unauthorizedRejected = error instanceof Error && error.message === "Unauthorized";
  }
  if (!unauthorizedRejected) throw new Error("Worker event ingest accepted an invalid token");
  const startedAt = performance.now();
  await ingest.ingest(first);
  await waitUntil(async () => {
    const cursor = await database
      .selectFrom("session_event_cursors")
      .select("last_projected_seq")
      .where("session_id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    return cursor.last_projected_seq === "2";
  });
  const firstProjectionMs = performance.now() - startedAt;
  await ingest.ingest(first);
  const rawPostgresCount = await database
    .selectFrom("session_events")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("session_id", "=", session.sessionId)
    .executeTakeFirstOrThrow();
  if (rawPostgresCount.count !== "0") throw new Error("Streaming deltas leaked into PostgreSQL");

  await projector.close();
  const second = publication(3, [" survives ", "restart"]);
  await ingest.ingest(second);
  const lagged = await database
    .selectFrom("session_event_cursors")
    .select(["last_persisted_seq", "last_projected_seq"])
    .where("session_id", "=", session.sessionId)
    .executeTakeFirstOrThrow();
  if (lagged.last_persisted_seq !== "4" || lagged.last_projected_seq !== "2") {
    throw new Error("Kafka durability/projection lag boundary was not observable");
  }
  projector = new KafkaWorkerEventProjector({
    brokers,
    clientId: "pi-cloud-enterprise-projector-restarted",
    topic,
    groupId,
    sink: store,
    partitionsConsumedConcurrently: 4,
  });
  await projector.start();
  await new PostgresEventProjectionBarrier({ database }).waitForSession(
    ids.tenant,
    session.sessionId,
  );
  const terminalEventId = randomUUID();
  const terminalNow = new Date();
  const terminalBody = {
    type: "turn.completed" as const,
    payload: { stopReason: "acceptance_complete" },
  };
  const preparedProjection = await new HttpTerminalTurnProjectionSource({
    baseUrl: address,
    serviceToken,
  }).prepare({
    tenantId: ids.tenant,
    sessionId: session.sessionId,
    turnId: accepted.turnId,
    commandId: accepted.commandId,
    agentId: "root",
    body: terminalBody,
    eventId: terminalEventId,
    occurredAt: terminalNow.toISOString(),
  });
  const terminal = await database.transaction().execute((transaction) =>
    commitTerminalTurnEvent(transaction, {
      tenantId: ids.tenant,
      sessionId: session.sessionId,
      turnId: accepted.turnId,
      commandId: accepted.commandId,
      agentId: "root",
      leaseId,
      fencingToken: 1,
      body: terminalBody,
      now: terminalNow,
      eventId: terminalEventId,
      preparedProjection,
    }),
  );
  if (terminal.seq !== 5) throw new Error("Terminal projection barrier was not contiguous");
  const replay = await store.openReplayWindow(ids.tenant, session.sessionId, 0);
  const projectionOffsets = await database
    .selectFrom("worker_event_projection_offsets")
    .select(["topic", "partition", "last_offset"])
    .where("consumer_group", "=", groupId)
    .execute();
  const outbox = await sql<{ relation: string | null }>`
    select to_regclass('public.worker_event_outbox')::text as relation
  `.execute(database);
  if (outbox.rows[0]?.relation !== null) throw new Error("Legacy Worker event Outbox still exists");
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    kafka: { brokers, topic, groupId },
    postgres: { realServer: true },
    assertions: {
      validAuthenticationAccepted: true,
      invalidAuthenticationRejected: true,
      kafkaFirstDurability: true,
      duplicateProjectionIsIdempotent: true,
      projectorRestartRecovered: true,
      terminalBarrierContiguous: true,
      postgresPayloadOutboxAbsent: true,
      postgresRawStreamingRows: Number(rawPostgresCount.count),
      projectedEventCount: replay.events.length,
      projectionPartitionCount: projectionOffsets.length,
    },
    latencyMs: { coldFirstBatchAckAndProjection: Number(firstProjectionMs.toFixed(2)) },
    scope: [
      "real PostgreSQL server and real single Kafka broker",
      "real Valkey server for rebuildable live replay",
      "functional restart and idempotency acceptance",
      "not a multi-broker HA, failover, or capacity claim",
    ],
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownReportPath = reportPath.endsWith(".json")
    ? `${reportPath.slice(0, -5)}.md`
    : `${reportPath}.md`;
  await writeFile(
    markdownReportPath,
    `# Enterprise event-pipeline acceptance\n\n` +
      `- Measured: ${report.measuredAt}\n` +
      `- PostgreSQL: real server\n` +
      `- Kafka: real single broker\n` +
      `- Valkey: real server\n` +
      `- Projected events: ${String(report.assertions.projectedEventCount)}\n` +
      `- Invalid service token rejected: yes\n` +
      `- Duplicate projection rows: 0\n` +
      `- Projector stop/restart recovery: passed\n` +
      `- Terminal projection barrier: passed\n` +
      `- PostgreSQL payload Outbox present: no\n\n` +
      `- PostgreSQL raw streaming rows: ${String(report.assertions.postgresRawStreamingRows)}\n\n` +
      `This is a single-node functional acceptance, not a multi-broker HA, failover, or capacity claim.\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await gateway?.close().catch(() => undefined);
  await projector?.close().catch(() => undefined);
  await eventLog?.close().catch(() => undefined);
  await liveEvents.close().catch(() => undefined);
  await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
  await application?.close().catch(() => undefined);
  await database.destroy().catch(() => undefined);
}
