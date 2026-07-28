import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piRoot = join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const checkOnly = process.argv.slice(2).includes("--check");

const securityPatches = [
  {
    name: "brace-expansion",
    sourcePackage: "pi-security-brace-expansion",
    version: "5.0.8",
    targetRoot: join(piRoot, "node_modules", "brace-expansion"),
  },
  {
    name: "minimatch",
    sourcePackage: "pi-security-minimatch",
    version: "10.2.6",
    targetRoot: join(piRoot, "node_modules", "minimatch"),
    declaringPackageRoot: piRoot,
  },
  {
    name: "protobufjs",
    sourcePackage: "pi-security-protobufjs",
    version: "7.6.5",
    targetRoot: join(piRoot, "node_modules", "protobufjs"),
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
    declaringPackageRoot: join(repositoryRoot, "node_modules", "@nestjs", "platform-fastify"),
  },
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

const piVersion = readPackageVersion(piRoot);
if (piVersion === null) {
  console.log("pi_dependency_hardening_skipped package_not_installed");
  process.exit(0);
}

if (piVersion !== "0.80.10") {
  throw new Error(`Pi dependency hardening has not been reviewed for pi-coding-agent ${piVersion}`);
}

function inspectPatches() {
  return securityPatches
    .filter(
      (securityPatch) =>
        securityPatch.declaringPackageRoot === undefined ||
        readPackageVersion(securityPatch.declaringPackageRoot) !== null,
    )
    .map((securityPatch) => ({
      ...securityPatch,
      actualVersion: readPackageVersion(securityPatch.targetRoot),
      declaredVersion:
        securityPatch.declaringPackageRoot === undefined
          ? null
          : JSON.parse(
              readFileSync(join(securityPatch.declaringPackageRoot, "package.json"), "utf8"),
            ).dependencies?.[securityPatch.name],
    }));
}

let installedPatches = inspectPatches();
const missingPatches = installedPatches.filter(
  (securityPatch) =>
    securityPatch.actualVersion !== securityPatch.version ||
    (securityPatch.declaringPackageRoot !== undefined &&
      securityPatch.declaredVersion !== securityPatch.version),
);

if (missingPatches.length > 0 && checkOnly) {
  throw new Error(
    `Pi security dependencies are not hardened: ${missingPatches
      .map(
        (securityPatch) =>
          `${securityPatch.name}=${securityPatch.actualVersion ?? "missing"} declared=${securityPatch.declaredVersion ?? "unchanged"} (expected ${securityPatch.version})`,
      )
      .join(", ")}`,
  );
}

if (missingPatches.length > 0) {
  for (const securityPatch of missingPatches) {
    if (securityPatch.actualVersion !== securityPatch.version) {
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

    if (
      securityPatch.declaringPackageRoot !== undefined &&
      securityPatch.declaredVersion !== securityPatch.version
    ) {
      const packagePath = join(securityPatch.declaringPackageRoot, "package.json");
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      packageJson.dependencies[securityPatch.name] = securityPatch.version;
      writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    }
  }
  installedPatches = inspectPatches();
}

const incorrectPatches = installedPatches.filter(
  (securityPatch) =>
    securityPatch.actualVersion !== securityPatch.version ||
    (securityPatch.declaringPackageRoot !== undefined &&
      securityPatch.declaredVersion !== securityPatch.version),
);
if (incorrectPatches.length > 0) {
  throw new Error(
    `Failed to install Pi security dependencies: ${incorrectPatches
      .map((securityPatch) => `${securityPatch.name}=${securityPatch.actualVersion ?? "missing"}`)
      .join(", ")}`,
  );
}

console.log(
  `pi_dependency_hardening_passed pi=${piVersion} ${installedPatches
    .map((securityPatch) => `${securityPatch.name}=${securityPatch.actualVersion}`)
    .join(" ")}`,
);
