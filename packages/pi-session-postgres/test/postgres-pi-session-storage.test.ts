import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPiSessionStorage } from "../src/index.ts";

const TENANT_ID = "d1000000-0000-4000-8000-000000000001";
const SESSION_ID = "d1000000-0000-4000-8000-000000000002";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

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
    .values({ id: TENANT_ID, slug: "pi-session-postgres" })
    .execute();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("PostgresPiSessionStorage", () => {
  it("persists bounded branch context and durable operation records without a JSONL download", async () => {
    const storage = await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      createdAt: 1_700_000_000_000,
    });
    const session = storage.asSession();
    const firstId = await session.appendMessage({
      role: "user",
      content: "first",
      timestamp: 1_700_000_000_000,
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      provider: "test",
      model: "test",
      api: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_700_000_000_001,
    });
    const compactId = await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000010",
        type: "compaction",
        summary: "earlier work",
        retainedTail: [],
        tokensBefore: 2,
      },
      "main",
    );
    await session.appendMessage({
      role: "user",
      content: "after compact",
      timestamp: 1_700_000_000_002,
    });

    const leaf = await session.getLeafId();
    expect(leaf).toBeDefined();
    const active = (
      await storage.findEntriesOnBranch({
        start: leaf!,
        stopAtType: "compaction",
        order: "newestFirst",
      })
    ).reverse();
    expect(active.map((entry) => entry.id)).toEqual([compactId.id, leaf]);
    expect((await storage.getEntry(firstId))?.type).toBe("message");

    await storage.appendRecord({
      id: "d1000000-0000-4000-8000-000000000020",
      lane: "main",
      type: "operation_started",
      sourceLeafId: leaf!,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    expect(await storage.findOpenOperations("main", { limit: 2 })).toHaveLength(1);
    await storage.appendRecord({
      id: "d1000000-0000-4000-8000-000000000021",
      lane: "main",
      type: "operation_finished",
      runId: "d1000000-0000-4000-8000-000000000020",
      outcome: "completed",
    });
    expect(await storage.findOpenOperations("main", { limit: 2 })).toEqual([]);

    await storage.setName("durable session");
    await storage.setLabel(leaf!, "current");
    await storage.createLane("review", leaf!);
    expect((await storage.getLog()).map((item) => item.kind)).toEqual([
      "entry",
      "entry",
      "entry",
      "entry",
      "record",
      "record",
      "fact",
      "fact",
      "lane",
    ]);
  });

  it("checks the opaque execution authority before every mutation", async () => {
    let receivedTransaction = false;
    const storage = new PostgresPiSessionStorage({
      database,
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      authority: {
        async assertCurrent(transaction) {
          receivedTransaction = transaction !== undefined;
          throw new Error("stale authority");
        },
      },
    });
    await expect(storage.setName("rejected")).rejects.toThrow("stale authority");
    expect(receivedTransaction).toBe(true);
    await expect(storage.getName()).resolves.toBe("durable session");
  });

  it("matches Pi branch ordering, bounds, filters and limits in one recursive query", async () => {
    const sessionId = "d1000000-0000-4000-8000-000000000030";
    const storage = await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId,
    });
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000031",
        type: "message",
        message: { role: "user", content: "root", timestamp: 1 },
      },
      "main",
    );
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000032",
        type: "custom",
        customType: "note",
        data: 1,
      },
      "main",
    );
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000033",
        type: "compaction",
        summary: "summary",
        retainedTail: [],
        tokensBefore: 2,
      },
      "main",
    );
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000034",
        type: "custom",
        customType: "note",
        data: 2,
      },
      "main",
    );
    const tail = await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000035",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "tail" }],
          provider: "test",
          model: "test",
          api: "test",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      "main",
    );

    expect(
      (
        await storage.findEntriesOnBranch({
          start: tail.id,
          stopAtType: "custom",
          order: "oldestFirst",
        })
      ).map((entry) => entry.id),
    ).toEqual(["d1000000-0000-4000-8000-000000000031", "d1000000-0000-4000-8000-000000000032"]);
    expect(
      (
        await storage.findEntriesOnBranch({
          start: tail.id,
          stopAtType: "custom",
          order: "newestFirst",
        })
      ).map((entry) => entry.id),
    ).toEqual(["d1000000-0000-4000-8000-000000000035", "d1000000-0000-4000-8000-000000000034"]);
    expect(
      (
        await storage.findEntriesOnBranch({
          start: tail.id,
          customType: "note",
          limit: 1,
        })
      ).map((entry) => entry.id),
    ).toEqual(["d1000000-0000-4000-8000-000000000034"]);
    await expect(
      storage.findEntriesOnBranch({
        start: "d1000000-0000-4000-8000-000000000039",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
