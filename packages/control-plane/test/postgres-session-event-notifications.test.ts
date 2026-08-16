import { createDatabase, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  PostgresSessionEventNotifications,
  parseSessionEventNotificationPayload,
  type SessionEventNotification,
} from "../src/index.ts";

const TENANT_ID = "00000000-0000-4000-8000-0000000000f1";
const FOREIGN_TENANT_ID = "00000000-0000-4000-8000-0000000000f2";
const SESSION_ID = "10000000-0000-4000-8000-0000000000f1";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PostgreSQL notification");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function notification(throughSequence: number, tenantId = TENANT_ID): SessionEventNotification {
  return {
    schemaVersion: 1,
    tenantId,
    sessionId: SESSION_ID,
    throughSequence,
  };
}

describe("PostgreSQL session event notifications", () => {
  it("strictly parses bounded versioned high-water hints", () => {
    expect(parseSessionEventNotificationPayload(JSON.stringify(notification(7)))).toEqual(
      notification(7),
    );
    expect(parseSessionEventNotificationPayload(undefined)).toBeUndefined();
    expect(parseSessionEventNotificationPayload("not-json")).toBeUndefined();
    expect(
      parseSessionEventNotificationPayload(
        JSON.stringify({ ...notification(7), schemaVersion: 2 }),
      ),
    ).toBeUndefined();
    expect(
      parseSessionEventNotificationPayload(
        JSON.stringify({ ...notification(7), throughSequence: 0 }),
      ),
    ).toBeUndefined();
    expect(parseSessionEventNotificationPayload("x".repeat(7_901))).toBeUndefined();
  });

  it.skipIf(!process.env.PI_CLOUD_TEST_DATABASE_URL)(
    "publishes all tenant hints only after commit and reconnects one deployment listener",
    async () => {
      const connectionString = process.env.PI_CLOUD_TEST_DATABASE_URL!;
      const database: Kysely<Database> = createDatabase({ connectionString, maxConnections: 2 });
      const applicationName = `pi-cloud-notify-${globalThis.crypto.randomUUID().slice(0, 20)}`;
      const listener = new PostgresSessionEventNotifications({
        connectionString,
        applicationName,
        initialReconnectDelayMs: 20,
        maxReconnectDelayMs: 100,
        stableConnectionMs: 100,
      });
      const foreignPublisher = new PostgresSessionEventNotifications({
        connectionString,
      });
      const received: SessionEventNotification[] = [];
      let resyncs = 0;

      try {
        await listener.start({
          onNotification: (value) => received.push(value),
          onResync: () => {
            resyncs += 1;
          },
        });
        expect(listener.state).toBe("listening");
        expect(listener.successfulConnections).toBe(1);

        await expect(
          database.transaction().execute(async (transaction) => {
            await listener.publish(transaction, notification(1));
            throw new Error("rollback-notification");
          }),
        ).rejects.toThrow("rollback-notification");
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
        expect(received).toEqual([]);

        await database
          .transaction()
          .execute((transaction) => listener.publish(transaction, notification(1)));
        await waitFor(() => received.length === 1);
        expect(received).toEqual([notification(1)]);

        await database
          .transaction()
          .execute((transaction) =>
            foreignPublisher.publish(transaction, notification(1, FOREIGN_TENANT_ID)),
          );
        await waitFor(() => received.length === 2);
        expect(received).toEqual([notification(1), notification(1, FOREIGN_TENANT_ID)]);

        const terminated = await sql<{ terminated: boolean }>`
          select pg_terminate_backend(pid) as terminated
          from pg_stat_activity
          where application_name = ${applicationName}
            and pid <> pg_backend_pid()
        `.execute(database);
        expect(terminated.rows.some((row) => row.terminated)).toBe(true);
        await waitFor(() => listener.successfulConnections >= 2);
        expect(resyncs).toBeGreaterThanOrEqual(2);

        await database
          .transaction()
          .execute((transaction) => listener.publish(transaction, notification(2)));
        await waitFor(() => received.length === 3);
        expect(received).toEqual([
          notification(1),
          notification(1, FOREIGN_TENANT_ID),
          notification(2),
        ]);
      } finally {
        await listener.stop();
        await database.destroy();
      }
    },
    15_000,
  );
});
