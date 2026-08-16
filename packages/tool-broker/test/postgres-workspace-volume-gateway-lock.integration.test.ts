import { createDatabase } from "@pi-cloud/database";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceVolumeGatewayLock } from "../src/index.ts";

const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe.skipIf(connectionString === undefined)("PostgreSQL Workspace Volume Gateway lock", () => {
  it("serializes one shared Volume across independent service connections", async () => {
    const firstDatabase = createDatabase({
      connectionString: connectionString!,
      maxConnections: 1,
    });
    const secondDatabase = createDatabase({
      connectionString: connectionString!,
      maxConnections: 1,
    });
    resources.push(async () => firstDatabase.destroy());
    resources.push(async () => secondDatabase.destroy());

    const first = new PostgresWorkspaceVolumeGatewayLock(firstDatabase);
    const second = new PostgresWorkspaceVolumeGatewayLock(secondDatabase);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const volumeId = `adw-integration-${randomUUID()}`;
    const firstRun = first.withLock(volumeId, async () => {
      events.push("first-start");
      await held;
      events.push("first-end");
    });
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    const secondRun = second.withLock(volumeId, async () => {
      events.push("second-start", "second-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});
