import { createDatabase } from "./client.ts";
import { runMigrations, type MigrationDirection } from "./run-migrations.ts";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  throw new Error("Usage: npm run migrate --workspace @pi-cloud/database -- <up|down>");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const db = createDatabase({ connectionString });
try {
  const result = await runMigrations(db, direction as MigrationDirection);
  process.stdout.write(
    `${JSON.stringify(
      {
        direction: result.direction,
        migrations: result.results.map((migration) => ({
          name: migration.migrationName,
          direction: migration.direction,
          status: migration.status,
        })),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await db.destroy();
}
