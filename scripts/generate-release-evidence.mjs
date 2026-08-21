import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TRIVY_IMAGE =
  "aquasec/trivy@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e";
const TRIVY_IGNORE_POLICY = resolve(repositoryRoot, ".trivyignore.yaml");
const PRODUCTION_IMAGE_NAMES = [
  "control-plane",
  "supervisor-host",
  "tool-broker",
  "github-gateway",
  "web-ui",
  "provider-egress-relay",
];
const CUBE_PLATFORM_IMAGES = ["cube-api-authorizer", "cube-egress-gateway"];
const MAX_CAPTURE_BYTES = 64 * 1_024 * 1_024;

function parseArguments(argv) {
  const result = {
    outputDirectory: resolve(repositoryRoot, "dist/release-evidence"),
    cacheDirectory:
      process.env.PI_CLOUD_TRIVY_CACHE_DIRECTORY ??
      resolve(repositoryRoot, ".cache/pi-cloud-trivy"),
    imageVersion: process.env.PI_CLOUD_IMAGE_VERSION ?? "production",
    allowDirty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--output-dir", "--cache-dir", "--image-version"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--output-dir") result.outputDirectory = resolve(repositoryRoot, value);
      if (argument === "--cache-dir") result.cacheDirectory = resolve(repositoryRoot, value);
      if (argument === "--image-version") result.imageVersion = value;
      index += 1;
      continue;
    }
    if (argument === "--allow-dirty") {
      result.allowDirty = true;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run release:evidence -- [--output-dir EMPTY_PATH] [--cache-dir PATH] [--image-version VERSION] [--allow-dirty]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown release-evidence argument: ${argument}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result.imageVersion)) {
    throw new Error("Image version must contain only tag-safe characters");
  }
  if (!isAbsolute(result.outputDirectory) || !isAbsolute(result.cacheDirectory)) {
    throw new Error("Resolved evidence paths must be absolute");
  }
  return result;
}

function commandFailure(command, arguments_, error, stderr) {
  const detail = stderr.trim().slice(-2_000);
  return new Error(
    `${command} ${arguments_.join(" ")} failed (${error.message})${detail ? `: ${detail}` : ""}`,
  );
}

function capture(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      arguments_,
      {
        cwd: options.cwd ?? repositoryRoot,
        env: options.environment ?? process.env,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
        timeout: options.timeoutMs ?? 300_000,
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(commandFailure(command, arguments_, error, stderr));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.environment ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", () => rejectPromise(new Error(`${command} could not start`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
  });
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function fileEvidence(root, path) {
  const absolute = resolve(root, path);
  return {
    path,
    sha256: await sha256File(absolute),
    sizeBytes: (await stat(absolute)).size,
  };
}

function trivyContainerArguments({ cacheDirectory, inputDirectory, outputDirectory, network }) {
  const uid = process.getuid?.() ?? 1_000;
  const gid = process.getgid?.() ?? 1_000;
  return [
    "run",
    "--rm",
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--mount",
    `type=bind,source=${cacheDirectory},target=/cache`,
    "--mount",
    `type=bind,source=${inputDirectory},target=/input,readonly`,
    "--mount",
    `type=bind,source=${outputDirectory},target=/output`,
    "--mount",
    `type=bind,source=${TRIVY_IGNORE_POLICY},target=/policy/.trivyignore.yaml,readonly`,
    TRIVY_IMAGE,
  ];
}

function vulnerabilitySummary(report) {
  const summary = {
    HIGH: { total: 0, fixable: 0 },
    CRITICAL: { total: 0, fixable: 0 },
  };
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (vulnerability.Severity !== "HIGH" && vulnerability.Severity !== "CRITICAL") continue;
      summary[vulnerability.Severity].total += 1;
      if (typeof vulnerability.FixedVersion === "string" && vulnerability.FixedVersion !== "") {
        summary[vulnerability.Severity].fixable += 1;
      }
    }
  }
  return summary;
}

async function inspectImage(reference, imageVersion, revision) {
  const values = JSON.parse(await capture("docker", ["image", "inspect", reference]));
  assert.equal(values.length, 1, `Expected one local image for ${reference}`);
  const image = values[0];
  const labels = image.Config?.Labels ?? {};
  assert.equal(
    labels["org.opencontainers.image.version"],
    imageVersion,
    `${reference} has the wrong OCI version label`,
  );
  assert.equal(
    labels["org.opencontainers.image.revision"],
    revision,
    `${reference} has the wrong OCI revision label`,
  );
  assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
  return {
    reference,
    imageId: image.Id,
    repoDigests: Array.isArray(image.RepoDigests) ? image.RepoDigests.toSorted() : [],
    created: image.Created,
    platform: `${image.Os}/${image.Architecture}`,
    labels: {
      title: labels["org.opencontainers.image.title"],
      version: labels["org.opencontainers.image.version"],
      revision: labels["org.opencontainers.image.revision"],
    },
  };
}

async function prepareDestination(path) {
  if (await exists(path)) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Release evidence destination must be a real directory");
    }
    if ((await readdir(path)).length > 0) {
      throw new Error("Release evidence destination must be absent or empty");
    }
    await rm(path, { recursive: true });
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

const options = parseArguments(process.argv.slice(2));
const revision = await capture("git", ["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Git HEAD is not a full commit SHA");
const dirty = (await capture("git", ["status", "--porcelain"])).length > 0;
if (dirty && !options.allowDirty) {
  throw new Error("Refusing release evidence from a dirty worktree; commit or pass --allow-dirty");
}
await prepareDestination(options.outputDirectory);
await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });
const destinationParent = dirname(options.outputDirectory);
const stageDirectory = await mkdtemp(join(destinationParent, ".pi-cloud-release-"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-cloud-release-"));

try {
  await mkdir(resolve(stageDirectory, "images"), { mode: 0o700 });
  const rootSbomPath = resolve(stageDirectory, "pi-cloud-root.cdx.json");
  const rootSbom = await capture("npm", ["sbom", "--sbom-format=cyclonedx", "--omit=dev"]);
  JSON.parse(rootSbom);
  await writeFile(rootSbomPath, `${rootSbom}\n`, { mode: 0o600 });
  await writeFile(
    resolve(stageDirectory, ".trivyignore.yaml"),
    await readFile(TRIVY_IGNORE_POLICY),
    { mode: 0o600 },
  );

  const trivyBase = trivyContainerArguments({
    cacheDirectory: options.cacheDirectory,
    inputDirectory: temporaryDirectory,
    outputDirectory: stageDirectory,
    network: "bridge",
  });
  await run("docker", [...trivyBase, "image", "--cache-dir", "/cache", "--download-db-only"]);

  const images = [];
  const imageDescriptors = [
    ...PRODUCTION_IMAGE_NAMES.map((imageName) => ({
      imageName,
      reference: `pi-cloud/${imageName}:${options.imageVersion}`,
      labelVersion: options.imageVersion,
    })),
    ...CUBE_PLATFORM_IMAGES.map((imageName) => ({
      imageName,
      reference: `pi-cloud/${imageName}:local`,
      labelVersion: "cube-primary",
    })),
    {
      imageName: "cubesandbox-tool",
      reference: `localhost:5000/pi-cloud/cubesandbox-tool:${revision}`,
      labelVersion: "cube-primary",
    },
  ];
  for (const { imageName, reference, labelVersion } of imageDescriptors) {
    const evidence = await inspectImage(reference, labelVersion, revision);
    const archiveName = `${imageName}.tar`;
    const archivePath = resolve(temporaryDirectory, archiveName);
    await run("docker", ["image", "save", "--output", archivePath, reference]);
    await chmod(archivePath, 0o600);

    const outputRoot = `images/${imageName}`;
    const reportRelativePath = `${outputRoot}.vulnerabilities.json`;
    const policyReportRelativePath = `${outputRoot}.policy-vulnerabilities.json`;
    const sbomRelativePath = `${outputRoot}.cdx.json`;
    const scanBase = trivyContainerArguments({
      cacheDirectory: options.cacheDirectory,
      inputDirectory: temporaryDirectory,
      outputDirectory: stageDirectory,
      network: "none",
    });
    const common = [
      "image",
      "--cache-dir",
      "/cache",
      "--input",
      `/input/${archiveName}`,
      "--skip-db-update",
      "--skip-java-db-update",
      "--scanners",
      "vuln",
      "--severity",
      "HIGH,CRITICAL",
      ...(imageName === "cubesandbox-tool" ? ["--pkg-types", "os"] : []),
    ];
    await run("docker", [
      ...scanBase,
      ...common,
      "--format",
      "json",
      "--output",
      `/output/${reportRelativePath}`,
    ]);
    await run("docker", [
      ...scanBase,
      ...common,
      "--format",
      "cyclonedx",
      "--output",
      `/output/${sbomRelativePath}`,
    ]);
    await run("docker", [
      ...scanBase,
      ...common,
      "--ignorefile",
      "/policy/.trivyignore.yaml",
      "--format",
      "json",
      "--output",
      `/output/${policyReportRelativePath}`,
    ]);
    const report = JSON.parse(await readFile(resolve(stageDirectory, reportRelativePath), "utf8"));
    const policyReport = JSON.parse(
      await readFile(resolve(stageDirectory, policyReportRelativePath), "utf8"),
    );
    const vulnerabilities = vulnerabilitySummary(report);
    const policyVulnerabilities = vulnerabilitySummary(policyReport);
    images.push({
      ...evidence,
      vulnerabilities,
      policyVulnerabilities,
      vulnerabilityReport: await fileEvidence(stageDirectory, reportRelativePath),
      policyVulnerabilityReport: await fileEvidence(stageDirectory, policyReportRelativePath),
      sbom: await fileEvidence(stageDirectory, sbomRelativePath),
    });
  }

  const blocked = images.filter(
    (image) =>
      image.policyVulnerabilities.HIGH.fixable > 0 ||
      image.policyVulnerabilities.CRITICAL.fixable > 0,
  );
  const manifest = {
    format: "pi-cloud.release-evidence.v1",
    generatedAt: new Date().toISOString(),
    git: { revision, dirty },
    imageVersion: options.imageVersion,
    policy: {
      scanner: TRIVY_IMAGE,
      severities: ["HIGH", "CRITICAL"],
      reportUnfixed: true,
      maximumFixableFindings: 0,
      exceptionPolicy: await fileEvidence(stageDirectory, ".trivyignore.yaml"),
      packageTypeOverrides: {
        "localhost:5000/pi-cloud/cubesandbox-tool": {
          packageTypes: ["os"],
          rationale:
            "Repository npm audit/SBOM covers its application packages; this image scan covers the Cube guest's OS packages without requiring Trivy's optional Java index. CI still performs the unrestricted image scan.",
        },
      },
    },
    rootSbom: await fileEvidence(stageDirectory, relative(stageDirectory, rootSbomPath)),
    images,
  };
  const manifestPath = resolve(stageDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const evidencePaths = [
    "pi-cloud-root.cdx.json",
    ".trivyignore.yaml",
    "manifest.json",
    ...images.flatMap((image) => [
      image.sbom.path,
      image.vulnerabilityReport.path,
      image.policyVulnerabilityReport.path,
    ]),
  ].toSorted();
  const checksums = await Promise.all(
    evidencePaths.map(
      async (path) => `${await sha256File(resolve(stageDirectory, path))}  ${path}`,
    ),
  );
  await writeFile(resolve(stageDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, {
    mode: 0o600,
  });

  if (blocked.length > 0) {
    throw new Error(
      `Release blocked by fixable HIGH/CRITICAL findings: ${blocked
        .map(
          (image) =>
            `${image.reference} (policy fixable HIGH=${String(image.policyVulnerabilities.HIGH.fixable)}, policy fixable CRITICAL=${String(image.policyVulnerabilities.CRITICAL.fixable)})`,
        )
        .join(", ")}`,
    );
  }
  await rename(stageDirectory, options.outputDirectory);
  process.stdout.write(
    `${JSON.stringify({ releaseEvidence: "passed", outputDirectory: options.outputDirectory, revision, dirty, images: images.length })}\n`,
  );
} catch (error) {
  process.stderr.write(`Release evidence retained for diagnosis at ${stageDirectory}\n`);
  throw error;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
