import { createDatabase } from "@agent-dock/database";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadProductionDatabaseUrl } from "./production-config.ts";
import {
  WorkspaceCellMigrationError,
  WorkspaceCellMigrationService,
} from "./workspace-cell-migration-service.ts";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function usage(): void {
  process.stdout.write(`Usage:
  workspace-cell-admin.ts state --cell <cell-id> --state <active|draining|disabled>
  workspace-cell-admin.ts move --tenant <uuid> --workspace <uuid> --target <cell-id> --actor <user-uuid> --idempotency-key <key>
  workspace-cell-admin.ts drain --source <cell-id> --target <cell-id> --actor <user-uuid>
`);
}

export async function runWorkspaceCellAdmin(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }
  const database = createDatabase({
    connectionString: await loadProductionDatabaseUrl(),
    maxConnections: 4,
  });
  try {
    const service = new WorkspaceCellMigrationService({ database });
    if (command === "state") {
      const cellId = option("--cell");
      const state = option("--state");
      if (state !== "active" && state !== "draining" && state !== "disabled") {
        throw new TypeError("--state is invalid");
      }
      await service.setCellState(cellId, state);
      process.stdout.write(`${JSON.stringify({ cellId, state })}\n`);
      return;
    }
    if (command === "move") {
      const result = await service.migrate({
        tenantId: option("--tenant"),
        workspaceId: option("--workspace"),
        targetCellId: option("--target"),
        requestedByUserId: option("--actor"),
        idempotencyKey: option("--idempotency-key"),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "drain") {
      const sourceCellId = option("--source");
      const targetCellId = option("--target");
      const requestedByUserId = option("--actor");
      if (sourceCellId === targetCellId) throw new TypeError("source and target must differ");
      await service.setCellState(sourceCellId, "draining");
      const invocationId = randomUUID();
      const workspaces = await service.listWorkspaceIds(sourceCellId);
      const migrated: string[] = [];
      const blocked: { workspaceId: string; code: string; retryable: boolean }[] = [];
      for (const workspace of workspaces) {
        try {
          await service.migrate({
            tenantId: workspace.tenantId,
            workspaceId: workspace.workspaceId,
            targetCellId,
            requestedByUserId,
            idempotencyKey: `drain:${invocationId}:${workspace.workspaceId}:${targetCellId}`,
          });
          migrated.push(workspace.workspaceId);
        } catch (error) {
          if (!(error instanceof WorkspaceCellMigrationError)) throw error;
          blocked.push({
            workspaceId: workspace.workspaceId,
            code: error.code,
            retryable: error.retryable,
          });
        }
      }
      const remaining = await service.listWorkspaceIds(sourceCellId);
      if (remaining.length === 0) await service.setCellState(sourceCellId, "disabled");
      process.stdout.write(
        `${JSON.stringify({
          sourceCellId,
          targetCellId,
          migrated,
          blocked,
          remaining: remaining.map((workspace) => workspace.workspaceId),
          state: remaining.length === 0 ? "disabled" : "draining",
        })}\n`,
      );
      if (blocked.length > 0) process.exitCode = 2;
      return;
    }
    throw new TypeError(`Unknown command ${command}`);
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runWorkspaceCellAdmin().catch((error) => {
    const detail =
      error instanceof WorkspaceCellMigrationError
        ? { code: error.code, retryable: error.retryable }
        : { code: "invalid_operation", retryable: false };
    process.stderr.write(`${JSON.stringify({ error: detail })}\n`);
    process.exitCode = 1;
  });
}
