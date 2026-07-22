import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packagesDirectory = resolve(repositoryRoot, "packages");
const packageDirectories = await readdir(packagesDirectory, { withFileTypes: true });
const workspaces = new Map();

for (const entry of packageDirectories) {
  if (!entry.isDirectory()) continue;
  const directory = resolve(packagesDirectory, entry.name);
  const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  assert.equal(typeof manifest.name, "string", `${entry.name} has no package name`);
  workspaces.set(manifest.name, { directory: entry.name, manifest });
}

const rootName = "@agent-dock/supervisor-host";
const pending = [rootName];
const closure = new Set();
while (pending.length > 0) {
  const name = pending.pop();
  if (closure.has(name)) continue;
  const workspace = workspaces.get(name);
  assert(workspace, `Unknown internal workspace dependency ${name}`);
  closure.add(name);
  const dependencies = {
    ...workspace.manifest.dependencies,
    ...workspace.manifest.optionalDependencies,
  };
  for (const dependencyName of Object.keys(dependencies)) {
    if (workspaces.has(dependencyName)) pending.push(dependencyName);
  }
}

const dockerfile = await readFile(
  resolve(packagesDirectory, "supervisor-host", "Dockerfile"),
  "utf8",
);
for (const name of [...closure].sort()) {
  const workspace = workspaces.get(name);
  const packageCopy = `COPY packages/${workspace.directory}/package.json packages/${workspace.directory}/package.json`;
  const packageCopies = dockerfile.split(packageCopy).length - 1;
  assert.equal(
    packageCopies,
    2,
    `${name} must copy its package.json into both Supervisor image stages`,
  );
  const sourceCopy = `COPY packages/${workspace.directory}/src packages/${workspace.directory}/src`;
  assert(
    dockerfile.includes(sourceCopy),
    `${name} must copy its runtime source into the Supervisor image`,
  );
}

process.stdout.write(
  `supervisor_image_closure_passed workspaces=${String(closure.size)} root=${rootName}\n`,
);
