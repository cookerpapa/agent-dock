import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piRoots = [
  join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
  join(
    repositoryRoot,
    "packages",
    "sandbox-supervisor",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  ),
  join(
    repositoryRoot,
    "spikes",
    "pi-embedded-rehydrate",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  ),
].filter((path) => existsSync(path));
const checkOnly = process.argv.slice(2).includes("--check");

const patchSpecs = [
  {
    name: "brace-expansion",
    sourcePackage: "pi-security-brace-expansion",
    version: "5.0.9",
    packageName: "brace-expansion",
  },
  {
    name: "undici",
    sourcePackage: "pi-security-undici",
    version: "8.10.0",
    packageName: "undici",
  },
  {
    name: "protobufjs",
    sourcePackage: "pi-security-protobufjs",
    version: "7.6.5",
    packageName: "protobufjs",
  },
  {
    name: "find-my-way",
    sourcePackage: "platform-security-find-my-way",
    version: "9.7.0",
    targetRoot: join(
      repositoryRoot,
      "node_modules",
      "@nestjs",
      "platform-fastify",
      "node_modules",
      "find-my-way",
    ),
  },
];
const securityPatches = [
  ...piRoots.flatMap((piRoot) =>
    patchSpecs
      .filter((spec) => "packageName" in spec)
      .map((spec) => ({ ...spec, targetRoot: join(piRoot, "node_modules", spec.packageName) })),
  ),
  ...patchSpecs.filter((spec) => !("packageName" in spec)),
];

function readPackageVersion(packageRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

const piVersions = [...new Set(piRoots.map(readPackageVersion))];
if (piVersions.length === 0) {
  console.log("pi_dependency_hardening_skipped package_not_installed");
  process.exit(0);
}

if (piVersions.length !== 1 || piVersions[0] !== "0.84.1") {
  throw new Error(
    `Pi dependency hardening has not been reviewed for pi-coding-agent ${piVersions.join(",")}`,
  );
}

function inspectPatches() {
  return securityPatches.map((securityPatch) => ({
    ...securityPatch,
    actualVersion: readPackageVersion(securityPatch.targetRoot),
  }));
}

let installedPatches = inspectPatches();
const missingPatches = installedPatches.filter(
  (securityPatch) => securityPatch.actualVersion !== securityPatch.version,
);

if (missingPatches.length > 0 && checkOnly) {
  throw new Error(
    `Pi security dependencies are not hardened: ${missingPatches
      .map(
        (securityPatch) =>
          `${securityPatch.name}=${securityPatch.actualVersion ?? "missing"} (expected ${securityPatch.version})`,
      )
      .join(", ")}`,
  );
}

if (missingPatches.length > 0) {
  for (const securityPatch of missingPatches) {
    const sourceRoot = join(repositoryRoot, "node_modules", securityPatch.sourcePackage);
    const sourceVersion = readPackageVersion(sourceRoot);
    if (sourceVersion !== securityPatch.version) {
      throw new Error(
        `Missing verified Pi security patch source ${securityPatch.sourcePackage}@${securityPatch.version}`,
      );
    }

    const targetRoot = securityPatch.targetRoot;
    const temporaryRoot = `${targetRoot}.agent-dock-${process.pid}`;
    rmSync(temporaryRoot, { recursive: true, force: true });
    cpSync(sourceRoot, temporaryRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const copiedVersion = readPackageVersion(temporaryRoot);
    if (copiedVersion !== securityPatch.version) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      throw new Error(
        `Copied Pi security patch ${securityPatch.name} has version ${copiedVersion ?? "missing"}`,
      );
    }
    rmSync(targetRoot, { recursive: true, force: true });
    renameSync(temporaryRoot, targetRoot);
  }
  installedPatches = inspectPatches();
}

const incorrectPatches = installedPatches.filter(
  (securityPatch) => securityPatch.actualVersion !== securityPatch.version,
);
if (incorrectPatches.length > 0) {
  throw new Error(
    `Failed to install Pi security dependencies: ${incorrectPatches
      .map((securityPatch) => `${securityPatch.name}=${securityPatch.actualVersion ?? "missing"}`)
      .join(", ")}`,
  );
}

console.log(
  `pi_dependency_hardening_passed pi=${piVersions[0]} roots=${String(piRoots.length)} ${installedPatches
    .map((securityPatch) => `${securityPatch.name}=${securityPatch.actualVersion}`)
    .join(" ")}`,
);
