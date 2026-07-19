import {
  parseControlToSupervisorMessage,
  type SupervisorRegisteredMessage,
} from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import {
  ReconnectingSupervisorWebSocketClient,
  SupervisorWebSocketClientError,
  type ReconnectingSupervisorCommandRuntime,
  type SupervisorWebSocketClientClose,
  type SupervisorWebSocketConnection,
} from "../src/index.ts";

const IDENTITY = {
  supervisorId: "supervisor-reconnect-test",
  bootId: "11111111-1111-4111-8111-111111111111",
  sandboxId: "22222222-2222-4222-8222-222222222222",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function registered(connectionId: string): SupervisorRegisteredMessage {
  const message = parseControlToSupervisorMessage({
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type: "supervisor.registered",
    payload: {
      supervisorId: IDENTITY.supervisorId,
      bootId: IDENTITY.bootId,
      connectionId,
      selectedProtocolVersion: 1,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_000,
      serverTime: new Date().toISOString(),
    },
  });
  if (message.type !== "supervisor.registered") throw new Error("Expected registration ACK");
  return message;
}

function close(
  retryable: boolean,
  options: Partial<SupervisorWebSocketClientClose> = {},
): SupervisorWebSocketClientClose {
  return {
    initiatedByClient: false,
    code: retryable ? 1_006 : 1_008,
    reason: retryable ? "transport interrupted" : "connection rejected",
    retryable,
    ...options,
  };
}

class FakeConnection implements SupervisorWebSocketConnection {
  readonly assignmentStates: boolean[] = [];
  readonly #started = deferred<SupervisorRegisteredMessage>();
  readonly #closed = deferred<SupervisorWebSocketClientClose>();
  #connectionId: string | undefined;
  #closeSettled = false;
  #startSettled = false;

  get connectionId(): string | undefined {
    return this.#connectionId;
  }

  setAcceptingAssignments(value: boolean): void {
    this.assignmentStates.push(value);
  }

  start(): Promise<SupervisorRegisteredMessage> {
    return this.#started.promise;
  }

  waitUntilClosed(): Promise<SupervisorWebSocketClientClose> {
    return this.#closed.promise;
  }

  async stop(): Promise<SupervisorWebSocketClientClose> {
    if (!this.#startSettled) {
      this.#startSettled = true;
      this.#started.reject(
        new SupervisorWebSocketClientError(
          "supervisor_client_stopped",
          "Supervisor connection was stopped",
          false,
        ),
      );
    }
    this.disconnect(
      close(false, {
        initiatedByClient: true,
        code: 1_000,
        reason: "client shutdown",
      }),
    );
    return this.#closed.promise;
  }

  connect(connectionId: string): void {
    if (this.#startSettled) throw new Error("Connection start already settled");
    this.#startSettled = true;
    this.#connectionId = connectionId;
    this.#started.resolve(registered(connectionId));
  }

  rejectStart(error: SupervisorWebSocketClientError, result: SupervisorWebSocketClientClose): void {
    if (this.#startSettled) throw new Error("Connection start already settled");
    this.#startSettled = true;
    this.#started.reject(error);
    this.disconnect(result);
  }

  disconnect(result: SupervisorWebSocketClientClose): void {
    if (this.#closeSettled) return;
    this.#closeSettled = true;
    this.#closed.resolve(result);
  }
}

function runtime(
  waitUntilAssignmentsSettled: () => Promise<void> = async () => undefined,
): ReconnectingSupervisorCommandRuntime {
  return {
    createHeartbeat() {
      throw new Error("Fake connection does not request heartbeats");
    },
    applyHeartbeatAcknowledgement() {
      return undefined;
    },
    prepare() {
      throw new Error("Fake connection does not deliver commands");
    },
    prepareCancellation() {
      throw new Error("Fake connection does not deliver cancellations");
    },
    revokeAllAssignments() {
      return undefined;
    },
    waitUntilAssignmentsSettled,
  };
}

function reconnecting(options: {
  runtime?: ReconnectingSupervisorCommandRuntime;
  assignmentTeardownTimeoutMs?: number;
}) {
  const connections: FakeConnection[] = [];
  const client = new ReconnectingSupervisorWebSocketClient({
    url: "ws://127.0.0.1:65535/internal/v1/supervisor",
    authorizationHeader: `Bearer agent-dock-${"x".repeat(48)}`,
    registration: { ...IDENTITY, maxConcurrentSessions: 2 },
    runtime: options.runtime ?? runtime(),
    initialReconnectDelayMs: 2,
    maxReconnectDelayMs: 8,
    reconnectBackoffMultiplier: 2,
    stableConnectionMs: 10_000,
    assignmentTeardownTimeoutMs: options.assignmentTeardownTimeoutMs ?? 100,
    random: () => 0,
    connectionFactory() {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  });
  return { client, connections };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reconnect condition");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
  }
}

describe("ReconnectingSupervisorWebSocketClient", () => {
  it("waits for revoked assignments, reconnects, and preserves drain state", async () => {
    const teardown = deferred<void>();
    let teardownCalls = 0;
    const harness = reconnecting({
      runtime: runtime(() => {
        teardownCalls += 1;
        return teardownCalls === 1 ? teardown.promise : Promise.resolve();
      }),
    });
    harness.client.setAcceptingAssignments(false);
    const started = harness.client.start();
    await waitFor(() => harness.connections.length === 1);
    const firstId = globalThis.crypto.randomUUID();
    harness.connections[0]!.connect(firstId);
    expect((await started).payload.connectionId).toBe(firstId);
    expect(harness.connections[0]!.assignmentStates).toEqual([false]);

    harness.connections[0]!.disconnect(close(true));
    await waitFor(() => teardownCalls === 1);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(harness.connections).toHaveLength(1);

    teardown.resolve();
    await waitFor(() => harness.connections.length === 2);
    expect(harness.connections[1]!.assignmentStates).toEqual([false]);
    const secondId = globalThis.crypto.randomUUID();
    harness.connections[1]!.connect(secondId);
    await waitFor(() => harness.client.connectionId === secondId);
    expect(harness.client.successfulConnections).toBe(2);

    await expect(harness.client.stop()).resolves.toMatchObject({
      reason: "requested",
      connectionAttempts: 2,
      successfulConnections: 2,
    });
  });

  it("does not retry rejected authentication", async () => {
    const harness = reconnecting({});
    const started = harness.client.start();
    await waitFor(() => harness.connections.length === 1);
    harness.connections[0]!.rejectStart(
      new SupervisorWebSocketClientError(
        "supervisor_authentication_rejected",
        "Supervisor authentication was rejected",
        false,
      ),
      close(false),
    );

    await expect(started).rejects.toMatchObject({
      code: "supervisor_authentication_rejected",
      retryable: false,
    });
    await expect(harness.client.waitUntilStopped()).resolves.toMatchObject({
      reason: "terminal_failure",
      connectionAttempts: 1,
      successfulConnections: 0,
      failureCode: "supervisor_authentication_rejected",
    });
    expect(harness.connections).toHaveLength(1);
  });

  it("interrupts pending backoff when stopped", async () => {
    const harness = reconnecting({});
    const started = harness.client.start();
    await waitFor(() => harness.connections.length === 1);
    harness.connections[0]!.connect(globalThis.crypto.randomUUID());
    await started;
    harness.connections[0]!.disconnect(close(true));
    await waitFor(() => harness.client.state === "backing_off");

    await expect(harness.client.stop()).resolves.toMatchObject({
      reason: "requested",
      connectionAttempts: 1,
    });
    expect(harness.connections).toHaveLength(1);
  });

  it("fails closed when revoked assignments do not settle", async () => {
    const harness = reconnecting({
      runtime: runtime(() => new Promise<void>(() => undefined)),
      assignmentTeardownTimeoutMs: 10,
    });
    const started = harness.client.start();
    await waitFor(() => harness.connections.length === 1);
    harness.connections[0]!.connect(globalThis.crypto.randomUUID());
    await started;
    harness.connections[0]!.disconnect(close(true));

    await expect(harness.client.waitUntilStopped()).resolves.toMatchObject({
      reason: "terminal_failure",
      connectionAttempts: 1,
      successfulConnections: 1,
      failureCode: "assignment_teardown_timeout",
    });
    expect(harness.client.state).toBe("failed");
    expect(harness.connections).toHaveLength(1);
  });
});
