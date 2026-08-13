import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DurableAgentHarness,
  PostgresPiSessionStorage,
  type DurableAgentExecutionAuthority,
  type DurableAgentExecutionAuthorityProvider,
} from "../src/index.ts";

const TENANT_ID = "d2000000-0000-4000-8000-000000000001";
const SESSION_ID = "d2000000-0000-4000-8000-000000000002";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected mock model event");
      },
    );
  }
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

class TestAuthority implements DurableAgentExecutionAuthority {
  readonly #abort = new AbortController();
  current = true;
  closed = false;

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  async assertCurrent(): Promise<void> {
    if (!this.current) throw new Error("stale test authority");
  }

  revoke(): void {
    this.current = false;
    this.#abort.abort(new Error("stale test authority"));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function provider(authorities: TestAuthority[]): DurableAgentExecutionAuthorityProvider {
  return {
    async acquire() {
      const authority = new TestAuthority();
      authorities.push(authority);
      return authority;
    },
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  await runMigrations(database, "up");
  await database
    .insertInto("tenants")
    .values({ id: TENANT_ID, slug: "durable-agent-harness" })
    .execute();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("DurableAgentHarness", () => {
  it("restores Pi-native bounded context directly from SessionStorage", async () => {
    const storage = await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
    });
    const contexts: Context[] = [];
    const authorities: TestAuthority[] = [];
    let answer = 0;
    const createHarness = () =>
      new DurableAgentHarness({
        session: storage.asSession(),
        authorityProvider: provider(authorities),
        scope: {
          tenantId: TENANT_ID,
          sessionId: SESSION_ID,
          runId: globalThis.crypto.randomUUID(),
          attemptId: globalThis.crypto.randomUUID(),
        },
        model: getModel("openai", "gpt-4o-mini"),
        systemPrompt: "test",
        streamFn: (_model, context) => {
          contexts.push(structuredClone(context));
          const stream = new MockAssistantStream();
          queueMicrotask(() => {
            const message = assistant(`answer-${++answer}`);
            stream.push({ type: "done", reason: "stop", message });
          });
          return stream;
        },
      });

    await createHarness().prompt("first");
    await createHarness().prompt("second");

    await storage.appendEntry(
      {
        id: globalThis.crypto.randomUUID(),
        type: "compaction",
        summary: "The first two turns were completed.",
        retainedTail: [],
        tokensBefore: 4,
      },
      "main",
    );
    await createHarness().prompt("third");

    expect(contexts).toHaveLength(3);
    expect(contexts[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(contexts[2]?.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(contexts[2]?.messages[0])).toContain(
      "The first two turns were completed.",
    );
    expect(JSON.stringify(contexts[2]?.messages)).not.toContain("answer-1");
    expect(await storage.getStats()).toMatchObject({ messageCount: 6 });
    expect(await storage.findOpenOperations("main")).toEqual([]);
    expect(authorities.every((authority) => authority.closed)).toBe(true);
  });

  it("uses one authority for both the durable transcript and Tool effect boundary", async () => {
    const sessionId = "d2000000-0000-4000-8000-000000000003";
    const storage = await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId,
    });
    const authorities: TestAuthority[] = [];
    let toolExecuted = false;
    let request = 0;
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider(authorities),
      scope: {
        tenantId: TENANT_ID,
        sessionId,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      tools: [
        {
          name: "mutate",
          label: "Mutate",
          description: "test",
          parameters: { type: "object", properties: {}, additionalProperties: false } as any,
          async execute() {
            toolExecuted = true;
            return { content: [{ type: "text", text: "done" }], details: {} };
          },
        },
      ],
      streamFn: () => {
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          request += 1;
          const message =
            request === 1
              ? {
                  ...assistant(""),
                  content: [
                    { type: "toolCall" as const, id: "tool-1", name: "mutate", arguments: {} },
                  ],
                  stopReason: "toolUse" as const,
                }
              : assistant("unexpected");
          stream.push({
            type: "done",
            reason: request === 1 ? "toolUse" : "stop",
            message,
          });
        });
        return stream;
      },
      onEvent(event) {
        if (event.type === "tool_execution_start") authorities[0]?.revoke();
      },
    });

    await expect(harness.prompt("mutate now")).rejects.toThrow("stale test authority");
    expect(toolExecuted).toBe(false);
    expect(authorities[0]?.closed).toBe(true);
  });
});
