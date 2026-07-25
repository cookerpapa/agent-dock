import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (
  process.env.NODE_USE_ENV_PROXY !== "1" &&
  [process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.https_proxy, process.env.http_proxy]
    .filter(Boolean)
    .some((value) => value.length > 0)
) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const version = "v5.9.0";
const sha256 = "06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0";
const target = resolve(repositoryRoot, ".cache", "tools", `k3d-${version}`, "k3d");
const source = `https://github.com/k3d-io/k3d/releases/download/${version}/k3d-linux-amd64`;

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function validExisting() {
  try {
    await access(target, constants.X_OK);
    return (await digest(target)) === sha256;
  } catch {
    return false;
  }
}

if (!(await validExisting())) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const response = await fetch(source, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`k3d download failed with HTTP ${String(response.status)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) {
      throw new Error(`k3d checksum mismatch: expected ${sha256}, received ${actual}`);
    }
    await writeFile(temporary, bytes, { mode: 0o755, flag: "wx" });
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

process.stdout.write(`k3d_ready version=${version} sha256=${sha256}\n`);
