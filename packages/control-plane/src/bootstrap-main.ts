import { createDatabase, runMigrations } from "@agent-dock/database";
import { pathToFileURL } from "node:url";
import { bootstrapProductionDatabase, ProductionBootstrapError } from "./production-bootstrap.ts";
import {
  loadProductionApiToken,
  loadProductionBootstrapConfig,
  loadProductionDatabaseUrl,
} from "./production-config.ts";

export async function runProductionBootstrap(): Promise<void> {
  const bootstrapConfig = loadProductionBootstrapConfig();
  const [databaseUrl, apiToken] = await Promise.all([
    loadProductionDatabaseUrl(),
    loadProductionApiToken(),
  ]);
  const database = createDatabase({
    connectionString: databaseUrl,
    maxConnections: 2,
  });
  try {
    const migration = await runMigrations(database, "up");
    const result = await bootstrapProductionDatabase(database, bootstrapConfig, apiToken);
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
  runProductionBootstrap().catch((error: unknown) => {
    const failure =
      error instanceof ProductionBootstrapError
        ? { name: error.name, code: error.code, message: error.message }
        : error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "UnknownError", message: "Unknown production bootstrap failure" };
    process.stderr.write(`AgentDock production bootstrap failed ${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  });
}
