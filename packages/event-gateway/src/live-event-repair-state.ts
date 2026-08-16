import type { Database } from "@pi-cloud/database";
import type { LiveSessionEventStore } from "@pi-cloud/runtime-core/live-session-event-store";
import type { Kysely } from "kysely";

const PAGE_SIZE = 500;

export type MissingLiveSession = Readonly<{
  tenantId: string;
  sessionId: string;
  replayFloor: number;
  liveThrough: number;
}>;

export type KafkaTopicOffset = Readonly<{
  partition: number;
  offset: string;
  low: string;
}>;

/**
 * Returns the exclusive high watermark only for partitions that still retain
 * at least one record. Kafka may report a non-zero high watermark after every
 * record in a partition has expired (`low === high`).
 */
export function retainedKafkaPartitionEnds(
  offsets: readonly KafkaTopicOffset[],
): ReadonlyMap<number, bigint> {
  return new Map(
    offsets
      .map((offset) => [offset.partition, BigInt(offset.low), BigInt(offset.offset)] as const)
      .filter(([, low, high]) => high > low)
      .map(([partition, _low, high]) => [partition, high] as const),
  );
}

function safeSequence(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${description} is outside the non-negative safe integer range`);
  }
  return parsed;
}

export async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        await operation(values[index]!);
      }
    }),
  );
}

/** Finds durable live ranges whose first retained event is absent from Valkey. */
export async function findMissingLiveEventSessions(
  database: Kysely<Database>,
  liveEvents: LiveSessionEventStore,
): Promise<readonly MissingLiveSession[]> {
  const missing: MissingLiveSession[] = [];
  let afterSessionId: string | undefined;
  while (true) {
    let query = database
      .selectFrom("sessions as session_row")
      .innerJoin("session_event_cursors as cursor", "cursor.session_id", "session_row.id")
      .leftJoin("session_terminal_events as terminal", (join) =>
        join
          .onRef("terminal.tenant_id", "=", "session_row.tenant_id")
          .onRef("terminal.session_id", "=", "session_row.id")
          .onRef("terminal.seq", "=", "cursor.last_projected_seq"),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.tenant_id as tenantId",
        "cursor.replay_floor_seq as replayFloor",
        "cursor.last_projected_seq as projectedThrough",
        "terminal.seq as terminalSequence",
      ])
      .whereRef("cursor.last_projected_seq", ">", "cursor.replay_floor_seq")
      .orderBy("session_row.id", "asc")
      .limit(PAGE_SIZE);
    if (afterSessionId !== undefined) query = query.where("session_row.id", ">", afterSessionId);
    const rows = await query.execute();
    if (rows.length === 0) break;
    const candidates = rows
      .map((row): MissingLiveSession | undefined => {
        const replayFloor = safeSequence(row.replayFloor, "Replay floor");
        const projectedThrough = safeSequence(row.projectedThrough, "Projected sequence");
        const terminalSequence =
          row.terminalSequence === null
            ? undefined
            : safeSequence(row.terminalSequence, "Terminal sequence");
        const liveThrough =
          terminalSequence === projectedThrough ? projectedThrough - 1 : projectedThrough;
        return liveThrough <= replayFloor
          ? undefined
          : { tenantId: row.tenantId, sessionId: row.sessionId, replayFloor, liveThrough };
      })
      .filter((value): value is MissingLiveSession => value !== undefined);
    await mapConcurrent(candidates, 16, async (candidate) => {
      try {
        const first = await liveEvents.readPage(
          candidate.tenantId,
          candidate.sessionId,
          candidate.replayFloor,
          candidate.liveThrough,
          1,
        );
        if (first[0]?.seq !== candidate.replayFloor + 1) missing.push(candidate);
      } catch {
        missing.push(candidate);
      }
    });
    afterSessionId = rows.at(-1)!.sessionId;
  }
  return missing;
}

export function safeKafkaSequence(value: string | number | bigint, description: string): number {
  return safeSequence(value, description);
}
