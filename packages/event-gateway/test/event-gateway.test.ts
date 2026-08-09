import type { Database } from "@agent-dock/database";
import type {
  TenantApiAuthenticator,
  TenantRequestIdentity,
} from "@agent-dock/control-plane/tenant-identity";
import type { AgentDockEvent, EventAckMessage } from "@agent-dock/protocol";
import type { DurableEventLog } from "@agent-dock/runtime-core/durable-event-store";
import type {
  SessionEventNotification,
  SessionEventNotificationHandlers,
  SessionEventNotificationTransport,
} from "@agent-dock/runtime-core/session-event-notifications";
import type { Kysely, Transaction } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { EventGateway } from "../src/event-gateway.ts";

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
  await Promise.all(running.splice(0).map((gateway) => gateway.close().catch(() => undefined)));
});

describe("Event Gateway", () => {
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
});
