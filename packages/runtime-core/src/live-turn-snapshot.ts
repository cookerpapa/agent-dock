import { parseLiveTurnSnapshotResource, type LiveTurnSnapshotResource } from "@pi-cloud/protocol";

export interface LiveTurnSnapshotSource {
  read(tenantId: string, sessionId: string): Promise<LiveTurnSnapshotResource>;
}

/** Empty source used only by deterministic development composition. */
export class EmptyLiveTurnSnapshotSource implements LiveTurnSnapshotSource {
  async read(_tenantId: string, sessionId: string): Promise<LiveTurnSnapshotResource> {
    return parseLiveTurnSnapshotResource({ sessionId, replayAfterSequence: 0, turn: null });
  }
}
