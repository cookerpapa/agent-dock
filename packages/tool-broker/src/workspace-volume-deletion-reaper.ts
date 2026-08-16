import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  workspaceVolumeId,
  type WorkspaceVolumeGateway,
} from "./workspace-volume-gateway-contract.ts";

export type WorkspaceVolumeDeletionReaperOptions = Readonly<{
  database: Kysely<Database>;
  gateway: WorkspaceVolumeGateway;
  intervalMs?: number;
  batchSize?: number;
  clock?: () => Date;
  onError?: (error: unknown) => void;
}>;

type PendingWorkspaceDeletion = Readonly<{
  tenantId: string;
  workspaceId: string;
}>;

const LIVE_ACTIVATION_STATES = [
  "reserved",
  "materializing",
  "active",
  "warm",
  "cleaning",
  "unknown",
] as const;

/** Removes POSIX Workspace data only after every Cube activation has retired. */
export class WorkspaceVolumeDeletionReaper {
  readonly #database: Kysely<Database>;
  readonly #gateway: WorkspaceVolumeGateway;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #clock: () => Date;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;

  constructor(options: WorkspaceVolumeDeletionReaperOptions) {
    if (
      !Number.isSafeInteger(options.intervalMs ?? 30_000) ||
      (options.intervalMs ?? 30_000) < 1_000 ||
      (options.intervalMs ?? 30_000) > 3_600_000
    ) {
      throw new TypeError("Workspace deletion reaper interval was invalid");
    }
    if (
      !Number.isSafeInteger(options.batchSize ?? 16) ||
      (options.batchSize ?? 16) < 1 ||
      (options.batchSize ?? 16) > 256
    ) {
      throw new TypeError("Workspace deletion reaper batch size was invalid");
    }
    this.#database = options.database;
    this.#gateway = options.gateway;
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#batchSize = options.batchSize ?? 16;
    this.#clock = options.clock ?? (() => new Date());
    this.#onError =
      options.onError ??
      ((error: unknown) => {
        process.stderr.write(
          `Workspace deletion reaper failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
      });
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.runOnce().catch(this.#onError);
    this.#timer = setInterval(() => void this.runOnce().catch(this.#onError), this.#intervalMs);
    this.#timer.unref();
  }

  async runOnce(): Promise<number> {
    if (this.#running !== undefined) return this.#running;
    const running = this.#sweep().finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  async close(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #sweep(): Promise<number> {
    const pending = await sql<PendingWorkspaceDeletion>`
      select
        workspace.tenant_id as "tenantId",
        workspace.id as "workspaceId"
      from workspaces as workspace
      where workspace.deleted_at is not null
        and workspace.storage_purged_at is null
        and not exists (
          select 1
          from tool_broker_activations as activation
          where activation.tenant_id = workspace.tenant_id
            and activation.workspace_id = workspace.id
            and activation.state in (${sql.join(LIVE_ACTIVATION_STATES)})
        )
      order by workspace.deleted_at asc, workspace.id asc
      limit ${this.#batchSize}
    `.execute(this.#database);
    let purged = 0;
    for (const workspace of pending.rows) {
      await this.#gateway.delete({
        tenantId: workspace.tenantId,
        workspaceId: workspace.workspaceId,
        volumeId: workspaceVolumeId(workspace),
      });
      const purgedAt = this.#clock();
      const updated = await this.#database
        .updateTable("workspaces")
        .set({ storage_purged_at: purgedAt, updated_at: purgedAt })
        .where("tenant_id", "=", workspace.tenantId)
        .where("id", "=", workspace.workspaceId)
        .where("deleted_at", "is not", null)
        .where("storage_purged_at", "is", null)
        .where(
          sql<boolean>`not exists (
            select 1
            from tool_broker_activations as activation
            where activation.tenant_id = ${workspace.tenantId}
              and activation.workspace_id = ${workspace.workspaceId}
              and activation.state in (${sql.join(LIVE_ACTIVATION_STATES)})
          )`,
        )
        .executeTakeFirst();
      if (updated.numUpdatedRows === 1n) purged += 1;
    }
    return purged;
  }
}
