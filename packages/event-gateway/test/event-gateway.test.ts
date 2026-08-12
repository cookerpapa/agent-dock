import type { Database } from "@agent-dock/database";
import type {
  TenantApiAuthenticator,
  TenantRequestIdentity,
} from "@agent-dock/control-plane/tenant-identity";
import type { AgentDockEvent, EventAckMessage, EventPublishMessage } from "@agent-dock/protocol";
import type {
  DurableEventGroupIngestor,
  DurableEventLog,
} from "@agent-dock/runtime-core/durable-event-store";
import { DurableEventStoreError } from "@agent-dock/runtime-core/durable-event-store";
import { HttpDurableEventIngestor } from "@agent-dock/runtime-core/http-durable-event-ingestor";
import type {
  SessionEventNotification,
  SessionEventNotificationHandlers,
  SessionEventNotificationTransport,
} from "@agent-dock/runtime-core/session-event-notifications";
import type { Kysely, Transaction } from "kysely";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventGateway } from "../src/event-gateway.ts";
import { loadEventGatewayProductionConfig } from "../src/production-config.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000011";
const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const API_TOKEN = "a".repeat(32);

const identity: TenantRequestIdentity = {
  credentialId: "00000000-0000-4000-8000-000000000002",
  tenantId: TENANT_ID,
  tenantSlug: "test",
  userId: "00000000-0000-4000-8000-000000000003",
  displayName: "Test User",
  role: "owner",
  defaultModelProfileId: "00000000-0000-4000-8000-000000000004",
};

const event: AgentDockEvent = {
  schemaVersion: 1,
  eventId: "00000000-0000-4000-8000-000000000021",
  sessionId: SESSION_ID,
  turnId: "00000000-0000-4000-8000-000000000022",
  agentId: "test-agent",
  seq: 1,
  occurredAt: "2026-08-09T00:00:00.000Z",
  type: "assistant.text.delta",
  payload: { text: "hello" },
};

class StaticAuthenticator implements TenantApiAuthenticator {
  readonly #acceptedToken: string;

  constructor(acceptedToken: string) {
    this.#acceptedToken = acceptedToken;
  }

  authenticate(token: string): Promise<TenantRequestIdentity | undefined> {
    return Promise.resolve(token === this.#acceptedToken ? identity : undefined);
  }
}

class StaticEventLog implements DurableEventLog {
  ingest(): Promise<EventAckMessage> {
    return Promise.reject(new Error("not used"));
  }

  openReplayWindow(tenantId: string, sessionId: string, afterSequence: number) {
    if (tenantId !== TENANT_ID || sessionId !== SESSION_ID) throw new Error("unexpected identity");
    return Promise.resolve({
      highWaterMark: 1,
      events: afterSequence < 1 ? [event] : [],
    });
  }

  readReplayPage() {
    return Promise.resolve([]);
  }
}

class FakeNotifications implements SessionEventNotificationTransport {
  handlers: SessionEventNotificationHandlers | undefined;

  publish(
    _transaction: Transaction<Database>,
    _notification: SessionEventNotification,
  ): Promise<void> {
    return Promise.resolve();
  }

  start(handlers: SessionEventNotificationHandlers): Promise<void> {
    this.handlers = handlers;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.handlers = undefined;
    return Promise.resolve();
  }
}

const running: EventGateway[] = [];

function createGateway(): EventGateway {
  const gateway = new EventGateway({
    database: {} as Kysely<Database>,
    eventLog: new StaticEventLog(),
    apiAuthenticator: new StaticAuthenticator(API_TOKEN),
    webSessionAuthenticator: new StaticAuthenticator("web-token"),
    notifications: new FakeNotifications(),
    heartbeatIntervalMs: 60_000,
  });
  running.push(gateway);
  return gateway;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(running.splice(0).map((gateway) => gateway.close().catch(() => undefined)));
});

describe("Event Gateway", () => {
  it("loads Kafka TLS/SCRAM only as one complete file-backed identity", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-dock-event-gateway-config-"));
    try {
      const database = resolve(root, "database-url");
      const ca = resolve(root, "ca.crt");
      const username = resolve(root, "username");
      const password = resolve(root, "password");
      const ingestToken = resolve(root, "worker-event-ingest-token");
      const liveEventStoreUrl = resolve(root, "live-event-store-url");
      await Promise.all([
        writeFile(database, "postgres://test\n", { mode: 0o600 }),
        writeFile(ca, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n", {
          mode: 0o600,
        }),
        writeFile(username, "agent-dock-event-gateway\n", { mode: 0o600 }),
        writeFile(password, "secret-password\n", { mode: 0o600 }),
        writeFile(ingestToken, `${"i".repeat(48)}\n`, { mode: 0o600 }),
        writeFile(liveEventStoreUrl, "rediss://valkey.example:6379\n", { mode: 0o600 }),
      ]);
      vi.stubEnv("DATABASE_URL_FILE", database);
      vi.stubEnv("AGENT_DOCK_KAFKA_BROKERS", "kafka.example:9093");
      vi.stubEnv("AGENT_DOCK_KAFKA_CA_FILE", ca);
      await expect(loadEventGatewayProductionConfig()).rejects.toThrow(
        "Kafka TLS/SASL secret files must be configured together",
      );
      vi.stubEnv("AGENT_DOCK_KAFKA_USERNAME_FILE", username);
      vi.stubEnv("AGENT_DOCK_KAFKA_PASSWORD_FILE", password);
      vi.stubEnv("AGENT_DOCK_WORKER_EVENT_INGEST_TOKEN_FILE", ingestToken);
      vi.stubEnv("AGENT_DOCK_LIVE_EVENT_STORE_URL_FILE", liveEventStoreUrl);
      await expect(loadEventGatewayProductionConfig()).resolves.toMatchObject({
        autoRepairLiveEvents: true,
        liveEventStoreUrl: "rediss://valkey.example:6379",
        kafka: {
          brokers: ["kafka.example:9093"],
          security: {
            username: "agent-dock-event-gateway",
            password: "secret-password",
            ca: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
          },
        },
      });
      vi.stubEnv("AGENT_DOCK_AUTO_REPAIR_LIVE_EVENTS", "false");
      await expect(loadEventGatewayProductionConfig()).resolves.toMatchObject({
        autoRepairLiveEvents: false,
      });
      vi.stubEnv("AGENT_DOCK_AUTO_REPAIR_LIVE_EVENTS", "sometimes");
      await expect(loadEventGatewayProductionConfig()).rejects.toThrow(
        "AGENT_DOCK_AUTO_REPAIR_LIVE_EVENTS must be true or false",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unauthenticated browser before opening a stream", async () => {
    const gateway = createGateway();
    const response = await gateway.application.inject({
      method: "GET",
      url: `/v1/sessions/${SESSION_ID}/events`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "authentication_required",
        message: "A valid AgentDock login session or API credential is required",
      },
    });
  });

  it("accepts Worker events only through the authenticated internal ingest boundary", async () => {
    const publication: EventPublishMessage = {
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: event.occurredAt,
      type: "event.publish",
      payload: {
        leaseId: globalThis.crypto.randomUUID(),
        fencingToken: 1,
        event,
      },
    };
    const store: DurableEventGroupIngestor = {
      ingest: (value) => store.ingestGroup([value]).then((values) => values[0]!),
      ingestGroup: (values) =>
        Promise.resolve(
          values.map((value) => {
            const message = value as EventPublishMessage;
            return {
              protocolVersion: 1 as const,
              messageId: globalThis.crypto.randomUUID(),
              sentAt: event.occurredAt,
              type: "event.ack" as const,
              payload: {
                sessionId: message.payload.event.sessionId,
                leaseId: message.payload.leaseId,
                fencingToken: message.payload.fencingToken,
                acknowledgedThroughSeq: message.payload.event.seq,
              },
            };
          }),
        ),
    };
    const serviceToken = "i".repeat(48);
    const gateway = new EventGateway({
      database: {} as Kysely<Database>,
      eventLog: new StaticEventLog(),
      apiAuthenticator: new StaticAuthenticator(API_TOKEN),
      webSessionAuthenticator: new StaticAuthenticator("web-token"),
      notifications: new FakeNotifications(),
      workerEventIngestor: store,
      workerEventIngestToken: serviceToken,
    });
    running.push(gateway);
    const unauthorized = await gateway.application.inject({
      method: "POST",
      url: "/internal/v1/worker-events",
      payload: { schemaVersion: 1, publications: [publication] },
    });
    expect(unauthorized.statusCode).toBe(401);

    const address = await gateway.listen(0, "127.0.0.1");
    const client = new HttpDurableEventIngestor({
      baseUrl: address,
      serviceToken,
      allowInsecureHttp: true,
    });
    await expect(client.ingest(publication)).resolves.toMatchObject({
      payload: { acknowledgedThroughSeq: 1 },
    });
  });

  it("replays only acknowledged durable events over resumable SSE", async () => {
    const gateway = createGateway();
    const address = await gateway.listen(0, "127.0.0.1");
    const abort = new AbortController();
    const response = await fetch(`${address}/v1/sessions/${SESSION_ID}/events`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const frame = new TextDecoder().decode(first.value);
    expect(frame).toContain("id: 1\n");
    expect(frame).toContain("event: assistant.text.delta\n");
    expect(frame).toContain('"text":"hello"');
    abort.abort();
  });

  it("tells a stale SSE client to reload the semantic conversation projection", async () => {
    const expiredEventLog: DurableEventLog = {
      ingest: () => Promise.reject(new Error("not used")),
      openReplayWindow: () =>
        Promise.reject(
          new DurableEventStoreError(
            "cursor_expired",
            "The requested event cursor is outside the retained hot window",
          ),
        ),
      readReplayPage: () => Promise.resolve([]),
    };
    const gateway = new EventGateway({
      database: {} as Kysely<Database>,
      eventLog: expiredEventLog,
      apiAuthenticator: new StaticAuthenticator(API_TOKEN),
      webSessionAuthenticator: new StaticAuthenticator("web-token"),
      notifications: new FakeNotifications(),
    });
    running.push(gateway);
    const response = await gateway.application.inject({
      method: "GET",
      url: `/v1/sessions/${SESSION_ID}/events`,
      headers: { authorization: `Bearer ${API_TOKEN}`, "last-event-id": "1" },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error: {
        code: "event_cursor_expired",
        message: "The retained event window moved forward; reload the conversation",
      },
    });
  });
});
