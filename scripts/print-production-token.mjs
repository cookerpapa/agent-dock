import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const tokenPath = resolve(runtimeDirectory, "secrets/api-token");
const handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const metadata = await handle.stat();
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Production API token file is not private");
  }
  process.stdout.write(await handle.readFile("utf8"));
} finally {
  await handle.close();
}
