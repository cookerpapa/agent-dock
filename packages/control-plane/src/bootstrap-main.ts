import { createDatabase, runMigrations } from "@agent-dock/database";
import { pathToFileURL } from "node:url";
import { bootstrapProductionDatabase } from "./production-bootstrap.ts";
import {
  loadProductionBootstrapConfig,
  loadProductionControlPlaneConfig,
} from "./production-config.ts";

export async function runProductionBootstrap(): Promise<void> {
  const [runtimeConfig, bootstrapConfig] = await Promise.all([
    loadProductionControlPlaneConfig(),
    Promise.resolve(loadProductionBootstrapConfig()),
  ]);
  if (
    runtimeConfig.tenantId !== bootstrapConfig.tenantId ||
    runtimeConfig.defaultModelProfileId !== bootstrapConfig.modelProfileId
  ) {
    throw new Error("Production runtime and bootstrap identities do not match");
  }
  const database = createDatabase({
    connectionString: runtimeConfig.databaseUrl,
    maxConnections: 2,
  });
  try {
    const migration = await runMigrations(database, "up");
    const result = await bootstrapProductionDatabase(database, bootstrapConfig);
    process.stdout.write(
      `${JSON.stringify({
        migrations: migration.results.map((item) => ({
          name: item.migrationName,
          status: item.status,
        })),
        bootstrap: result,
      })}\n`,
    );
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runProductionBootstrap().catch(() => {
    process.stderr.write("AgentDock production bootstrap failed\n");
    process.exitCode = 1;
  });
}
