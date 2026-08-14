import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
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

async function createStorage() {
  return PostgresPiSessionStorage.create({
    database,
    tenantId: TENANT_ID,
    sessionId: globalThis.crypto.randomUUID(),
  });
}

function scriptedStream(
  messages: string[],
  contexts: Context[] = [],
): (model: any, context: Context) => MockAssistantStream {
  let index = 0;
  return (_model, context) => {
    contexts.push(structuredClone(context));
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      const message = assistant(messages[index++] ?? `answer-${index}`);
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    // PGlite's socket adapter is single-connection; production PostgreSQL is
    // covered separately by the real cross-Worker acceptance suite.
    maxConnections: 1,
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
  it("implements the complete Pi 0.84.1 AgentHarness public surface", async () => {
    const storage = await createStorage();
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["unused"]),
    });
    const methods = [
      "getLeafId",
      "prompt",
      "skill",
      "promptFromTemplate",
      "compact",
      "navigateTree",
      "resume",
      "abort",
      "steer",
      "followUp",
      "nextRun",
      "cancelQueued",
      "recordUsage",
      "waitForIdle",
      "runWhenIdle",
      "peekAction",
      "executeAction",
      "runToCompletion",
      "getModel",
      "setModel",
      "getThinkingLevel",
      "setThinkingLevel",
      "getActiveTools",
      "setActiveTools",
      "watch",
      "lane",
      "createLane",
      "lanes",
      "getTools",
      "setTools",
      "getResources",
      "setResources",
      "getStreamOptions",
      "setStreamOptions",
      "getRetryPolicy",
      "setRetryPolicy",
      "getCompactionSettings",
      "setCompactionSettings",
      "getSteeringMode",
      "setSteeringMode",
      "getFollowUpMode",
      "setFollowUpMode",
      "watchSession",
      "close",
    ] as const;
    for (const method of methods) {
      expect(typeof (harness as unknown as Record<string, unknown>)[method], method).toBe(
        "function",
      );
    }
    expect(typeof harness.hooks.on).toBe("function");
    expect(typeof harness.events.on).toBe("function");
    await harness.close();
  });

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

    expect((await createHarness().prompt("first")).ok).toBe(true);
    expect((await createHarness().prompt("second")).ok).toBe(true);

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
    expect((await createHarness().prompt("third")).ok).toBe(true);

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

    const result = await harness.prompt("mutate now");
    expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
    expect(toolExecuted).toBe(false);
    expect(authorities[0]?.closed).toBe(true);
  });

  it("implements skills, prompt templates, mutable configuration, and durable usage", async () => {
    const storage = await createStorage();
    const authorities: TestAuthority[] = [];
    const contexts: Context[] = [];
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider(authorities),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      resources: {
        skills: [
          {
            name: "review",
            description: "Review a change",
            content: "Review carefully.",
            filePath: "/skills/review/SKILL.md",
          },
        ],
        promptTemplates: [{ name: "fix", content: "Fix $1 and verify $@" }],
      },
      streamFn: scriptedStream(["skill-ok", "template-ok"], contexts),
    });

    await harness.setThinkingLevel("medium");
    const skill = await harness.skill("review", "focus on recovery");
    const template = await harness.promptFromTemplate("fix", ["queue"]);
    expect(skill).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(template).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(JSON.stringify(contexts[0]?.messages)).toContain("Review carefully");
    expect(JSON.stringify(contexts[1]?.messages)).toContain("Fix queue");
    expect(await harness.getThinkingLevel()).toBe("medium");
    expect(
      await harness.recordUsage({
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      (await storage.findRecords({ type: "usage" })).some(
        (record) => record.cause === "adjustment",
      ),
    ).toBe(true);
    expect(authorities).toHaveLength(2);
  });

  it("persists before-Run recovery data and composes request, response, and Tool hooks", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    const requestMetadata: unknown[] = [];
    let executedValue: unknown;
    let request = 0;
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "base-system",
      tools: [
        {
          name: "echo",
          label: "Echo",
          description: "echo a value",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          } as any,
          async execute(_id, params) {
            executedValue = (params as { value: string }).value;
            return { content: [{ type: "text", text: String(executedValue) }], details: {} };
          },
        },
      ],
      streamFn: (_model, context, options) => {
        contexts.push({
          ...context,
          messages: structuredClone(context.messages),
          tools: [],
        });
        requestMetadata.push(structuredClone(options?.metadata));
        request += 1;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          const message =
            request === 1
              ? {
                  ...assistant(""),
                  content: [
                    {
                      type: "toolCall" as const,
                      id: "echo-1",
                      name: "echo",
                      arguments: { value: "original" },
                    },
                  ],
                  stopReason: "toolUse" as const,
                }
              : assistant("raw-final");
          stream.push({ type: "done", reason: request === 1 ? "toolUse" : "stop", message });
        });
        return stream;
      },
    });
    harness.hooks.on(
      "before_run",
      () => ({
        messages: [{ role: "user", content: "hook-injected", timestamp: Date.now() }],
        systemPrompt: "hook-system",
        resumeData: { version: 1 },
      }),
      { id: "test-extension" },
    );
    harness.hooks.on("before_request", () => ({
      streamOptions: { metadata: { hook: "request" } },
    }));
    harness.hooks.on("before_tool", () => ({ args: { value: "patched" } }));
    harness.hooks.on("after_tool", () => ({
      content: [{ type: "text", text: "hooked-tool-result" }],
    }));
    harness.hooks.on("after_response", (event) => {
      const value = event as { message?: AssistantMessage };
      if (value.message?.stopReason !== "stop") return undefined;
      return { message: { ...value.message, content: [{ type: "text", text: "hooked-final" }] } };
    });

    const result = await harness.prompt("run hooks");
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "completed",
        finalMessage: { content: [{ type: "text", text: "hooked-final" }] },
      },
    });
    expect(executedValue).toBe("patched");
    expect(contexts[0]?.systemPrompt).toBe("hook-system");
    expect(JSON.stringify(contexts[0]?.messages)).toContain("hook-injected");
    expect(JSON.stringify(contexts[1]?.messages)).toContain("hooked-tool-result");
    expect(requestMetadata).toEqual([{ hook: "request" }, { hook: "request" }]);
    const [operation] = await storage.findRecords({ type: "operation_started" });
    expect(operation?.intent).toMatchObject({
      kind: "run",
      systemPromptOverride: "hook-system",
      resumeData: { "test-extension": { version: 1 } },
    });
    const [startedTool] = await storage.findRecords({ type: "tool_started" });
    expect(startedTool?.effectiveArgs).toEqual({ value: "patched" });
  });

  it("fails a Tool closed when a policy Hook throws but keeps passive observers isolated", async () => {
    const storage = await createStorage();
    let executed = false;
    let request = 0;
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      tools: [
        {
          name: "dangerous",
          label: "Dangerous",
          description: "must be gated",
          parameters: { type: "object", properties: {}, additionalProperties: false } as any,
          async execute() {
            executed = true;
            return { content: [{ type: "text", text: "executed" }], details: {} };
          },
        },
      ],
      streamFn: () => {
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          request += 1;
          stream.push({
            type: "done",
            reason: request === 1 ? "toolUse" : "stop",
            message:
              request === 1
                ? {
                    ...assistant(""),
                    content: [
                      {
                        type: "toolCall",
                        id: "danger-1",
                        name: "dangerous",
                        arguments: {},
                      },
                    ],
                    stopReason: "toolUse",
                  }
                : assistant("continued-after-block"),
          });
        });
        return stream;
      },
    });
    harness.hooks.on("before_tool", () => {
      throw new Error("policy unavailable");
    });
    harness.events.on("*", () => {
      throw new Error("observer bug");
    });

    expect(await harness.prompt("try it")).toMatchObject({
      ok: true,
      value: { kind: "completed" },
    });
    expect(executed).toBe(false);
    expect(JSON.stringify(await storage.findEntries({ type: "message" }))).toContain(
      "Tool policy hook failed closed: policy unavailable",
    );
    expect(await storage.findRecords({ type: "tool_started" })).toEqual([]);
  });

  it("persists, cancels, and consumes next-Run queue items", async () => {
    const storage = await createStorage();
    const authorities: TestAuthority[] = [];
    const contexts: Context[] = [];
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider(authorities),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["done"], contexts),
    });

    const removed = await harness.nextRun("discard me");
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw removed.error;
    expect(await harness.cancelQueued(removed.value.entryId)).toEqual({
      ok: true,
      value: { outcome: "cancelled" },
    });

    const retained = await harness.nextRun("queued before prompt");
    expect(retained.ok).toBe(true);
    const result = await harness.prompt("current prompt");
    expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(JSON.stringify(contexts[0]?.messages)).toContain("queued before prompt");
    expect(JSON.stringify(contexts[0]?.messages)).not.toContain("discard me");
    if (!retained.ok) throw retained.error;
    expect(await harness.cancelQueued(retained.value.entryId)).toEqual({
      ok: true,
      value: { outcome: "already_consumed" },
    });
  });

  it("durably steers an active Agent Run", async () => {
    const storage = await createStorage();
    const authorities: TestAuthority[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    let request = 0;
    const contexts: Context[] = [];
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider(authorities),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: async (_model, context) => {
        contexts.push(structuredClone(context));
        request += 1;
        if (request === 1) await gate;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          const message = assistant(request === 1 ? "first" : "after-steer");
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    });

    const running = harness.prompt("start");
    let steering = await harness.steer("inspect before finishing");
    for (let index = 0; !steering.ok && index < 100; index += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      steering = await harness.steer("inspect before finishing");
    }
    expect(steering.ok).toBe(true);
    release();
    expect(await running).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1]?.messages)).toContain("inspect before finishing");
  });

  it("supports manual action driving without changing durable semantics", async () => {
    const storage = await createStorage();
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      drive: "manual",
      streamFn: scriptedStream(["manual-ok"]),
    });

    const running = harness.prompt("manual prompt");
    await harness.runToCompletion();
    expect(await running).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect(await harness.peekAction()).toBeUndefined();
    expect(await storage.findOpenOperations("main")).toEqual([]);
  });

  it("compacts with Pi's native preparation and summary format", async () => {
    const storage = await createStorage();
    const authorities: TestAuthority[] = [];
    let request = 0;
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider(authorities),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 64 },
      streamFn: (_model, context) => {
        request += 1;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          const isSummary = context.systemPrompt?.includes("context summarization") ?? false;
          const message = assistant(
            isSummary
              ? "## Goal\nPreserve the sorting work.\n## Progress\nTests passed."
              : `answer-${request}-${"x".repeat(2_000)}`,
          );
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    });

    for (let index = 0; index < 4; index += 1) {
      expect((await harness.prompt(`task-${index}-${"y".repeat(2_000)}`)).ok).toBe(true);
    }
    const result = await harness.compact();
    if (result.ok && result.value.kind === "failed") {
      throw new Error(`Compaction failed: ${JSON.stringify(result.value.error)}`);
    }
    expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
    expect((await storage.findEntries({ type: "compaction" })).length).toBe(1);
  });

  it("accepts a Hook-supplied compaction without making a summary model request", async () => {
    const storage = await createStorage();
    let modelRequests = 0;
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 32 },
      streamFn: (_model, _context) => {
        modelRequests += 1;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: assistant(`answer-${modelRequests}-${"x".repeat(2_000)}`),
          });
        });
        return stream;
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await harness.prompt(`large-${index}-${"y".repeat(2_000)}`);
    }
    harness.hooks.on("before_compaction", (event) => {
      const preparation = (
        event as { preparation: { retainedTail: unknown[]; tokensBefore: number } }
      ).preparation;
      return {
        compaction: {
          summary: "hook-supplied-summary",
          retainedTail: preparation.retainedTail,
          tokensBefore: preparation.tokensBefore,
        },
      };
    });
    const before = modelRequests;
    expect(await harness.compact()).toMatchObject({
      ok: true,
      value: { kind: "completed", entry: { summary: "hook-supplied-summary" } },
    });
    expect(modelRequests).toBe(before);
  });

  it("supports tree navigation, additional lanes, and live snapshots", async () => {
    const storage = await createStorage();
    const authorities: TestAuthority[] = [];
    const harness = new DurableAgentHarness({
      session: storage.asSession(),
      authorityProvider: provider(authorities),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["one", "two", "lane-answer"]),
    });
    const first = await harness.prompt("first");
    if (!first.ok || first.value.kind !== "completed") throw new Error("first Run failed");
    await harness.prompt("second");
    harness.hooks.on("before_navigation", () => ({
      summary: {
        summary: "hook-supplied-branch-summary",
        readFiles: ["/workspace/a.ts"],
        modifiedFiles: [],
      },
    }));
    const navigation = await harness.navigateTree(first.value.finalEntryId, { summarize: true });
    expect(navigation).toMatchObject({
      ok: true,
      value: {
        kind: "completed",
        summaryEntry: { summary: "hook-supplied-branch-summary" },
      },
    });

    const created = await harness.createLane("experiment", first.value.finalEntryId);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    const mainModel = await harness.getModel();
    const laneModel = { ...mainModel, id: "lane-only-model", name: "Lane-only model" };
    await created.value.setModel(laneModel);
    await created.value.setThinkingLevel("high");
    await created.value.setActiveTools([]);
    expect((await created.value.getModel()).id).toBe("lane-only-model");
    expect(await created.value.getThinkingLevel()).toBe("high");
    expect(await created.value.getActiveTools()).toEqual([]);
    expect((await harness.getModel()).id).toBe(mainModel.id);
    expect(await harness.getThinkingLevel()).toBe("off");
    const watch = await created.value.watch();
    let updates = 0;
    watch.start(() => {
      updates += 1;
    });
    expect(await created.value.prompt("branch task")).toMatchObject({
      ok: true,
      value: { kind: "completed" },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(watch.snapshot.lane).toBe("experiment");
    expect(watch.snapshot.transcript.length).toBeGreaterThan(1);
    expect(updates).toBeGreaterThan(0);
    watch.unsubscribe();
    expect((await harness.lanes()).map((lane) => lane.name)).toEqual(["experiment", "main"]);
  });

  it("resumes a suspended Run but never replays an unresolved unsafe Tool", async () => {
    const storage = await createStorage();
    const session = storage.asSession();
    const operationId = globalThis.crypto.randomUUID();
    const promptEntry = {
      id: globalThis.crypto.randomUUID(),
      type: "message" as const,
      message: { role: "user" as const, content: "resume me", timestamp: Date.now() },
    };
    await session.appendRecord({
      id: operationId,
      lane: "main",
      type: "operation_started",
      sourceLeafId: null,
      intent: {
        kind: "run",
        originalPrompt: [promptEntry.message],
        initialMessages: [promptEntry],
      },
    });
    const harness = new DurableAgentHarness({
      session,
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["resumed"]),
    });
    expect(await harness.resume()).toMatchObject({
      ok: true,
      value: { operation: "run", runId: operationId, kind: "completed" },
    });

    const unsafeStorage = await createStorage();
    const unsafeSession = unsafeStorage.asSession();
    const unsafeRunId = globalThis.crypto.randomUUID();
    const assistantEntryId = globalThis.crypto.randomUUID();
    const resultEntryId = globalThis.crypto.randomUUID();
    await unsafeSession.appendRecord({
      id: unsafeRunId,
      lane: "main",
      type: "operation_started",
      sourceLeafId: null,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    await unsafeSession.appendEntry(
      {
        id: assistantEntryId,
        type: "message",
        message: {
          ...assistant(""),
          content: [{ type: "toolCall", id: "unsafe-1", name: "bash", arguments: {} }],
          stopReason: "toolUse",
        },
      },
      "main",
    );
    await unsafeSession.appendRecord({
      id: globalThis.crypto.randomUUID(),
      lane: "main",
      type: "tool_started",
      runId: unsafeRunId,
      assistantEntryId,
      toolIndex: 0,
      toolCallId: "unsafe-1",
      toolName: "bash",
      effectiveArgs: {},
      resultEntryId,
      replay: "never",
    });
    const recoveredContexts: Context[] = [];
    const unsafeHarness = new DurableAgentHarness({
      session: unsafeSession,
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await unsafeStorage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["recovery-inspection-complete"], recoveredContexts),
    });
    expect(await unsafeHarness.resume()).toMatchObject({
      ok: true,
      value: { operation: "run", kind: "completed" },
    });
    expect(JSON.stringify(recoveredContexts[0]?.messages)).toContain("side effects are unknown");
    expect(
      (await unsafeStorage.findRecords({ type: "tool_started", runId: unsafeRunId })).length,
    ).toBe(1);
    expect(await unsafeStorage.findOpenOperations("main")).toEqual([]);
  });

  it("restores a deferred Run in a new Harness and preserves extension resume data", async () => {
    const storage = await createStorage();
    const model = getModel("openai", "gpt-4o-mini");
    const deferred = {
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      id: "deferred-1",
    };
    let fetches = 0;
    const models = {
      getModel(provider: string, modelId: string) {
        return provider === model.provider && modelId === model.id ? model : undefined;
      },
      streamSimple() {
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: { ...assistant(""), stopReason: "deferred", deferred },
          });
        });
        return stream;
      },
      async fetchDeferred() {
        fetches += 1;
        return assistant("deferred-complete");
      },
      async cancelDeferred() {},
    } as unknown as Models;
    const options = {
      session: storage.asSession(),
      authorityProvider: provider([]),
      scope: {
        tenantId: TENANT_ID,
        sessionId: (await storage.getMetadata()).id,
        runId: globalThis.crypto.randomUUID(),
        attemptId: globalThis.crypto.randomUUID(),
      },
      model,
      models,
      systemPrompt: "test",
    };
    const first = new DurableAgentHarness(options);
    await first.setThinkingLevel("medium");
    first.hooks.on("before_run", () => ({ resumeData: { policyVersion: 7 } }), {
      id: "cloud-policy",
    });
    expect(await first.prompt("defer this")).toMatchObject({
      ok: true,
      value: { kind: "suspended", deferred: { id: "deferred-1" } },
    });

    const restored = await DurableAgentHarness.create({
      ...options,
      authorityProvider: provider([]),
    });
    expect(restored.suspended).toMatchObject([
      { reason: "deferred", missing: { tools: [], models: [] } },
    ]);
    expect(await restored.harness.getThinkingLevel()).toBe("medium");
    const resumeData: unknown[] = [];
    restored.harness.hooks.on(
      "before_resume",
      (event) => {
        resumeData.push((event as { resumeData?: unknown }).resumeData);
      },
      { id: "cloud-policy" },
    );
    expect(await restored.harness.resume()).toMatchObject({
      ok: true,
      value: {
        operation: "run",
        kind: "completed",
        finalMessage: { content: [{ text: "deferred-complete" }] },
      },
    });
    expect(resumeData).toEqual([{ policyVersion: 7 }]);
    expect(fetches).toBe(1);
    expect(
      (await storage.findRecords({ type: "usage" })).some(
        (record) => record.cause === "deferred_fetch",
      ),
    ).toBe(true);
    expect(await storage.findOpenOperations("main")).toEqual([]);
  });
});
