import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Models,
} from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CloudAgentRuntime,
  PostgresPiSessionStorage,
  type CloudAgentExecutionAuthority,
  type CloudAgentRuntimeEvent,
} from "../src/index.ts";

const TENANT_ID = "d2000000-0000-4000-8000-000000000001";

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

function assistantError(message: string): AssistantMessage {
  return {
    ...assistant(""),
    stopReason: "error",
    errorMessage: message,
  };
}

class TestAuthority implements CloudAgentExecutionAuthority {
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

function scriptedStream(messages: string[], contexts: Context[] = []) {
  let index = 0;
  return (_model: unknown, context: Context) => {
    contexts.push(structuredClone(context));
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      const message = assistant(messages[index++] ?? `answer-${index}`);
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

async function createStorage() {
  return PostgresPiSessionStorage.create({
    database,
    tenantId: TENANT_ID,
    sessionId: globalThis.crypto.randomUUID(),
  });
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await database
    .insertInto("tenants")
    .values({ id: TENANT_ID, slug: "cloud-agent-runtime" })
    .execute();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("CloudAgentRuntime", () => {
  it("restores active Pi context from PostgreSQL without whole-history snapshots", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    const run = async (prompt: string, answerText: string) => {
      const authority = new TestAuthority();
      const runtime = new CloudAgentRuntime({
        session: storage.asSession(),
        authority,
        model: getModel("openai", "gpt-4o-mini"),
        systemPrompt: "test",
        streamFn: scriptedStream([answerText], contexts),
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      });
      expect(await runtime.run(prompt)).toMatchObject({
        kind: "completed",
        finalMessage: { content: [{ type: "text", text: answerText }] },
      });
      expect(authority.closed).toBe(false);
      await authority.close();
      expect(authority.closed).toBe(true);
    };

    await run("first", "answer-1");
    await run("second", "answer-2");

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[0]?.messages)).toContain("first");
    expect(JSON.stringify(contexts[1]?.messages)).toContain("answer-1");
    expect(JSON.stringify(contexts[1]?.messages)).toContain("second");
    expect(await storage.getStats()).toMatchObject({ messageCount: 4 });
    expect(await storage.findOpenOperations("main", { limit: 2 })).toEqual([]);
  });

  it("records Tool intent before the effect and binds it to the same authority", async () => {
    const storage = await createStorage();
    const authority = new TestAuthority();
    let request = 0;
    let executed = false;
    const runtime = new CloudAgentRuntime({
      session: storage.asSession(),
      authority,
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      tools: [
        {
          name: "mutate",
          label: "Mutate",
          description: "mutate the workspace",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          } as any,
          async execute() {
            executed = true;
            return { content: [{ type: "text", text: "done" }], details: {} };
          },
        },
      ],
      streamFn: (_model, _context) => {
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
              : assistant("verified");
          stream.push({
            type: "done",
            reason: request === 1 ? "toolUse" : "stop",
            message,
          });
        });
        return stream;
      },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });

    expect(await runtime.run("change it")).toMatchObject({ kind: "completed" });
    expect(executed).toBe(true);
    const [tool] = await storage.findRecords({ type: "tool_started" });
    expect(tool).toMatchObject({ toolCallId: "tool-1", toolName: "mutate", replay: "never" });
    expect(await storage.getEntry(tool!.resultEntryId)).toMatchObject({
      type: "message",
      message: { role: "toolResult", toolCallId: "tool-1", isError: false },
    });
  });

  it("keeps a bounded product follow-up inside the same native Agent Run", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    let followUpAvailable = true;
    const runtime = new CloudAgentRuntime({
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["first answer", "verified answer"], contexts),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      prepareFollowUp() {
        if (!followUpAvailable) return undefined;
        followUpAvailable = false;
        return {
          role: "custom",
          customType: "pi-cloud.test_follow_up",
          content: "verify before settling",
          display: false,
          timestamp: Date.now(),
        };
      },
    });

    const result = await runtime.run("make a change");
    expect(result.finalMessage.content).toEqual([{ type: "text", text: "verified answer" }]);
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1]?.messages)).toContain("verify before settling");
    expect((await storage.getStats()).messageCount).toBe(4);
  });

  it("retries a transient model failure without adding the failed assistant to context", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    const events: string[] = [];
    let request = 0;
    const runtime = new CloudAgentRuntime({
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: (_model, context) => {
        contexts.push(structuredClone(context));
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          request += 1;
          const message = request === 1 ? assistantError("network error") : assistant("recovered");
          if (message.stopReason === "error") {
            stream.push({ type: "error", reason: "error", error: message });
          } else {
            stream.push({ type: "done", reason: "stop", message });
          }
        });
        return stream;
      },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      onEvent(event) {
        events.push(event.type);
      },
    });

    expect(await runtime.run("recover transport")).toMatchObject({
      kind: "completed",
      finalMessage: { content: [{ type: "text", text: "recovered" }] },
    });
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1]?.messages)).toContain("recover transport");
    expect(JSON.stringify(contexts[1]?.messages)).not.toContain("network error");
    expect(events).toContain("auto_retry_start");
    expect(events).toContain("auto_retry_end");
    expect((await storage.getStats()).messageCount).toBe(2);
    expect(await storage.findRecords({ type: "step_attempt" })).toHaveLength(2);
  });

  it("settles an unresolved Tool as unknown instead of replaying it", async () => {
    const storage = await createStorage();
    const session = storage.asSession();
    const operationId = globalThis.crypto.randomUUID();
    const assistantEntryId = globalThis.crypto.randomUUID();
    const resultEntryId = globalThis.crypto.randomUUID();
    await session.appendRecord({
      id: operationId,
      lane: "main",
      type: "operation_started",
      sourceLeafId: null,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    await session.appendEntry(
      {
        id: assistantEntryId,
        type: "message",
        message: {
          ...assistant(""),
          content: [{ type: "toolCall", id: "unknown-1", name: "bash", arguments: {} }],
          stopReason: "toolUse",
        },
      },
      "main",
    );
    await session.appendRecord({
      id: globalThis.crypto.randomUUID(),
      lane: "main",
      type: "tool_started",
      runId: operationId,
      assistantEntryId,
      toolIndex: 0,
      toolCallId: "unknown-1",
      toolName: "bash",
      effectiveArgs: {},
      resultEntryId,
      replay: "never",
    });
    const contexts: Context[] = [];
    const runtime = new CloudAgentRuntime({
      session,
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["recovered"], contexts),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });

    await runtime.run("continue");
    expect(await session.getEntry(resultEntryId)).toMatchObject({
      type: "message",
      message: { role: "toolResult", isError: true },
    });
    expect(JSON.stringify(contexts[0]?.messages)).toContain("side effects are unknown");
    expect(JSON.stringify(contexts[0]?.messages)).toContain("<turn_aborted>");
  });

  it("writes a native compaction entry before sampling an oversized active context", async () => {
    const storage = await createStorage();
    const session = storage.asSession();
    await session.appendMessage({
      role: "user",
      content: "x".repeat(2_000),
      timestamp: Date.now(),
    });
    await session.appendMessage({
      ...assistant("old answer"),
      usage: {
        input: 50_000,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50_001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const contexts: Context[] = [];
    const model = { ...getModel("openai", "gpt-4o-mini"), contextWindow: 256 };
    const stream = scriptedStream(["after compaction"], contexts);
    const models = {
      streamSimple: stream,
      async completeSimple() {
        return assistant("summary of earlier work");
      },
    } as unknown as Models;
    const events: CloudAgentRuntimeEvent[] = [];
    const runtime = new CloudAgentRuntime({
      session,
      authority: new TestAuthority(),
      model,
      models,
      systemPrompt: "test",
      compaction: { enabled: true, reserveTokens: 32, keepRecentTokens: 32 },
      onEvent(event) {
        events.push(event);
      },
    });

    await runtime.run("continue after compacting");
    expect((await storage.findEntries({ type: "compaction" })).length).toBe(1);
    expect(events.some((event) => event.type === "compaction_start")).toBe(true);
    const completedCompaction = events.find(
      (event) => event.type === "compaction_end" && "success" in event && event.success,
    );
    expect(completedCompaction).toBeDefined();
    if (completedCompaction === undefined || !("result" in completedCompaction)) {
      throw new Error("Expected the Cloud runtime compaction result event");
    }
    expect(completedCompaction?.result?.estimatedTokensAfter).toBeLessThan(
      completedCompaction?.result?.tokensBefore ?? 0,
    );
    expect(JSON.stringify(contexts[0]?.messages)).toContain("summary of earlier work");
  });
});
