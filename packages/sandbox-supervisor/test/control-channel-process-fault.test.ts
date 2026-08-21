import { parseSupervisorToControlMessage } from "@pi-cloud/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ReconnectingSupervisorWebSocketClient,
  type ReconnectingSupervisorControlRuntime,
} from "../src/index.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/control-channel-process.mjs");
const IDENTITY = {
  supervisorId: "process-fault-supervisor",
  bootId: "11111111-1111-4111-8111-111111111111",
  sandboxId: "22222222-2222-4222-8222-222222222222",
};
async function startServer(
  port = 0,
): Promise<{ child: ChildProcess; port: number; eventReceived: Promise<number> }> {
  const child = spawn(process.execPath, [FIXTURE, String(port)], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  if (child.stderr === null) {
    throw new Error("Control Channel fixture stderr pipe was unavailable");
  }
  let resolveEvent!: (sequence: number) => void;
  const eventReceived = new Promise<number>((resolvePromise) => {
    resolveEvent = resolvePromise;
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const ready = await Promise.race([
    new Promise<{ port: number }>((resolvePromise) => {
      child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "event_received" &&
          "sequence" in message &&
          typeof message.sequence === "number"
        ) {
          resolveEvent(message.sequence);
        }
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ready" &&
          "port" in message &&
          typeof message.port === "number"
        ) {
          resolvePromise({ port: message.port });
        }
      });
    }),
    once(child, "exit").then(() => {
      throw new Error(`Control Channel fixture exited before readiness: ${stderr}`);
    }),
  ]);
  return { child, port: ready.port, eventReceived };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process fault condition");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

describe("Control Channel process fault", () => {
  it("keeps an active assignment alive while the Control Plane process is killed and replaced", async () => {
    const first = await startServer();
    let second: ChildProcess | undefined;
    let revocations = 0;
    let settleAssignments!: () => void;
    const assignmentsSettled = new Promise<void>((resolvePromise) => {
      settleAssignments = resolvePromise;
    });
    const runtime: ReconnectingSupervisorControlRuntime = {
      activeSessionCount: 0,
      createHeartbeat(identity, acceptingAssignments = false) {
        const message = parseSupervisorToControlMessage({
          protocolVersion: 1,
          messageId: globalThis.crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          type: "supervisor.heartbeat",
          payload: {
            ...identity,
            acceptingAssignments,
            maxConcurrentSessions: 1,
            sessions: [],
          },
        });
        if (message.type !== "supervisor.heartbeat") throw new Error("Heartbeat was invalid");
        return message;
      },
      applyHeartbeatAcknowledgement() {
        return undefined;
      },
      prepareSteer() {
        throw new Error("Fixture does not deliver steer commands");
      },
      revokeAllAssignments() {
        revocations += 1;
        settleAssignments();
      },
      waitUntilAssignmentsSettled: () => assignmentsSettled,
    };
    const client = new ReconnectingSupervisorWebSocketClient({
      url: `ws://127.0.0.1:${String(first.port)}`,
      authorizationHeader: "Bearer process-fault-token",
      registration: { ...IDENTITY, maxConcurrentSessions: 1 },
      runtime,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 100,
      stableConnectionMs: 1_000,
      assignmentTeardownTimeoutMs: 1_000,
      random: () => 0,
    });
    client.setAcceptingAssignments(false);
    try {
      await client.start();
      expect(client.successfulConnections).toBe(1);

      first.child.kill("SIGKILL");
      await once(first.child, "exit");
      await waitFor(() => client.state === "connecting" || client.state === "backing_off");
      expect(revocations).toBe(0);

      const replacement = await startServer(first.port);
      second = replacement.child;
      await waitFor(() => client.successfulConnections === 2);
      expect(client.state).toBe("connected");
      expect(revocations).toBe(0);

      await expect(client.stop()).resolves.toMatchObject({ reason: "requested" });
      expect(revocations).toBeGreaterThanOrEqual(1);
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null)
        first.child.kill("SIGKILL");
      if (second !== undefined && second.exitCode === null && second.signalCode === null) {
        second.kill("SIGKILL");
        await once(second, "exit").catch(() => undefined);
      }
    }
  }, 15_000);
});
