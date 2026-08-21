import { HttpTerminalTurnProjectionSource } from "@pi-cloud/runtime-core/terminal-turn-projection";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { TerminalTurnProjectionGateway } from "../src/terminal-turn-projection-gateway.ts";

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  session: "10000000-0000-4000-8000-000000000002",
  turn: "10000000-0000-4000-8000-000000000003",
  command: "10000000-0000-4000-8000-000000000004",
  event: "10000000-0000-4000-8000-000000000005",
} as const;

describe("TerminalTurnProjectionGateway", () => {
  it("returns the trusted Accepted Kafka prefix to an authenticated Worker", async () => {
    const fastify = Fastify({ logger: false });
    const token = `projection-${"p".repeat(48)}`;
    new TerminalTurnProjectionGateway({
      authorize(authorization) {
        if (authorization !== `Bearer ${token}`) {
          throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
        }
      },
      source: {
        async prepare(input) {
          if (input.body.type !== "turn.failed") throw new Error("expected failed terminal");
          return {
            schemaVersion: 1,
            previousSequence: 1,
            terminalEvent: {
              schemaVersion: 1,
              eventId: input.eventId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              agentId: input.agentId,
              seq: 2,
              occurredAt: input.occurredAt,
              ...input.body,
            },
            transcript: {
              schemaVersion: 1,
              startedSequence: 1,
              throughSequence: 2,
              terminalSequence: 2,
              stopReason: null,
              items: [{ kind: "text", text: "visible prefix", firstSequence: 1, lastSequence: 1 }],
              failure: input.body.payload,
              cancellation: null,
              workspacePatch: null,
            },
          };
        },
      },
    }).install(fastify);
    const baseUrl = await fastify.listen({ port: 0, host: "127.0.0.1" });
    try {
      const input = {
        tenantId: IDS.tenant,
        sessionId: IDS.session,
        turnId: IDS.turn,
        commandId: IDS.command,
        agentId: "root",
        body: {
          type: "turn.failed" as const,
          payload: { code: "failed", message: "failed", retryable: false },
        },
        eventId: IDS.event,
        occurredAt: new Date().toISOString(),
      };
      const client = new HttpTerminalTurnProjectionSource({
        baseUrl,
        serviceToken: token,
        timeoutMs: 2_000,
      });
      await expect(client.prepare(input)).resolves.toMatchObject({
        previousSequence: 1,
        transcript: { items: [{ kind: "text", text: "visible prefix" }] },
      });
      await expect(
        new HttpTerminalTurnProjectionSource({
          baseUrl,
          serviceToken: `wrong-${"w".repeat(48)}`,
          timeoutMs: 2_000,
        }).prepare(input),
      ).rejects.toThrow("HTTP 401");
    } finally {
      await fastify.close();
    }
  });
});
