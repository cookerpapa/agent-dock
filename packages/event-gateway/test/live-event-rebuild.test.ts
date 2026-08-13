import { createDatabase, runMigrations, type Database } from "@agent-dock/database";
import type { EventPublishMessage } from "@agent-dock/protocol";
import { MemoryLiveSessionEventStore } from "@agent-dock/runtime-core/live-session-event-store";
import { ValkeyLiveTurnSnapshotSource } from "@agent-dock/runtime-core/live-turn-snapshot";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findMissingLiveEventSessions,
  retainedKafkaPartitionEnds,
} from "../src/live-event-rebuild.ts";

const IDS = {
  tenant: "81000000-0000-4000-8000-000000000001",
  project: "81000000-0000-4000-8000-000000000002",
  workspace: "81000000-0000-4000-8000-000000000003",
  credential: "81000000-0000-4000-8000-000000000004",
  profile: "81000000-0000-4000-8000-000000000005",
  session: "81000000-0000-4000-8000-000000000006",
  turn: "81000000-0000-4000-8000-000000000007",
  command: "81000000-0000-4000-8000-000000000008",
  lease: "81000000-0000-4000-8000-000000000009",
} as const;

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;

function publication(sequence: number): EventPublishMessage {
  return {
    protocolVersion: 1,
    messageId: `82000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sentAt: "2026-08-12T00:00:00.000Z",
    type: "event.publish",
    payload: {
      commandId: IDS.command,
      leaseId: IDS.lease,
      fencingToken: 1,
      event: {
        schemaVersion: 1,
        eventId: `83000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        sessionId: IDS.session,
        turnId: IDS.turn,
        agentId: "root",
        seq: sequence,
        occurredAt: "2026-08-12T00:00:00.000Z",
        type: "assistant.text.delta",
        payload: { text: String(sequence) },
      },
    },
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await database.insertInto("tenants").values({ id: IDS.tenant, slug: "repair-owner" }).execute();
  await database
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "repair-project" })
    .execute();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      sandbox_domain_id: "sandbox-domain-0001",
      object_snapshot_key: null,
    })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "agent-dock-fake",
      kind: "api_key",
      secret_ref: "test://repair",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "repair-profile",
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .execute();
  await database
    .insertInto("sessions")
    .values({
      id: IDS.session,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: IDS.profile,
      state: "running",
      pi_session_snapshot_key: null,
      workspace_snapshot_key: null,
      next_event_seq: 3,
      last_fencing_token: 1,
      row_version: 1,
    })
    .execute();
  await database
    .insertInto("session_event_cursors")
    .values({
      session_id: IDS.session,
      last_persisted_seq: 2,
      last_projected_seq: 2,
      acknowledged_through_seq: 2,
      replay_floor_seq: 0,
    })
    .execute();
  await database
    .insertInto("turns")
    .values({
      id: IDS.turn,
      tenant_id: IDS.tenant,
      session_id: IDS.session,
      state: "running",
      input_kind: "prompt",
      input_text: "continue",
      model_profile_id: IDS.profile,
      provider: "agent-dock-fake",
      model_id: "agent-dock-fake",
      thinking_level: "off",
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
    })
    .execute();
  await database
    .insertInto("commands")
    .values({
      id: IDS.command,
      tenant_id: IDS.tenant,
      session_id: IDS.session,
      turn_id: IDS.turn,
      idempotency_key: "live-snapshot",
      kind: "turn.execute",
      mailbox_position: 1,
      state: "acknowledged",
      payload: { schemaVersion: 1 },
      acknowledged_at: new Date(),
      failure_code: null,
    })
    .execute();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

describe("live-event repair detection", () => {
  it("does not wait for partitions whose retained Kafka range is empty", () => {
    expect(
      retainedKafkaPartitionEnds([
        { partition: 0, low: "0", offset: "0" },
        { partition: 1, low: "126", offset: "126" },
        { partition: 2, low: "30", offset: "34" },
      ]),
    ).toEqual(new Map([[2, 34n]]));
  });

  it("finds a missing retained range and accepts its exact materialization", async () => {
    const liveEvents = new MemoryLiveSessionEventStore();
    await expect(findMissingLiveEventSessions(database, liveEvents)).resolves.toEqual([
      {
        tenantId: IDS.tenant,
        sessionId: IDS.session,
        replayFloor: 0,
        liveThrough: 2,
      },
    ]);
    await liveEvents.append({
      tenantId: IDS.tenant,
      sessionId: IDS.session,
      previousSequence: 0,
      messages: [publication(1), publication(2)],
    });
    await expect(findMissingLiveEventSessions(database, liveEvents)).resolves.toEqual([]);
    await expect(
      new ValkeyLiveTurnSnapshotSource({ database, liveEvents }).read(IDS.tenant, IDS.session),
    ).resolves.toMatchObject({
      sessionId: IDS.session,
      replayAfterSequence: 2,
      turn: {
        turnId: IDS.turn,
        transcript: {
          throughSequence: 2,
          items: [{ kind: "text", text: "12", firstSequence: 1, lastSequence: 2 }],
          terminalSequence: null,
        },
      },
    });

    // Simulate the Run settling after the source observed the active Turn but
    // before it read the projected cursor. The terminal event is PostgreSQL-
    // owned and must remain available to the following SSE catch-up instead of
    // being mistaken for a missing Valkey payload.
    await database
      .insertInto("session_terminal_events")
      .values({
        event_id: "84000000-0000-4000-8000-000000000002",
        tenant_id: IDS.tenant,
        session_id: IDS.session,
        turn_id: IDS.turn,
        agent_id: "root",
        command_id: IDS.command,
        seq: 2,
        schema_version: 1,
        type: "turn.completed",
        payload: {},
        occurred_at: new Date("2026-08-12T00:00:01.000Z"),
      })
      .execute();
    await expect(
      new ValkeyLiveTurnSnapshotSource({ database, liveEvents }).read(IDS.tenant, IDS.session),
    ).resolves.toMatchObject({
      sessionId: IDS.session,
      replayAfterSequence: 1,
      turn: {
        turnId: IDS.turn,
        transcript: {
          throughSequence: 1,
          items: [{ kind: "text", text: "1", firstSequence: 1, lastSequence: 1 }],
          terminalSequence: null,
        },
      },
    });
  });
});
