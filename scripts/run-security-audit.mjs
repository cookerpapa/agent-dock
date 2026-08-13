import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

execFileSync(
  process.execPath,
  [join(repositoryRoot, "scripts", "harden-pi-dependencies.mjs"), "--check"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);

let auditResult;
let auditReport;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  auditResult = spawnSync(npmCommand, ["audit", "--json", "--audit-level=high"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (auditResult.error) throw auditResult.error;

  try {
    const candidate = JSON.parse(auditResult.stdout);
    if (
      candidate?.error === undefined &&
      candidate?.metadata !== undefined &&
      candidate?.vulnerabilities !== undefined
    ) {
      auditReport = candidate;
      break;
    }
  } catch {
    // A truncated response is retried below and remains fail-closed.
  }
  if (attempt < 3) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 2_000));
  }
}
if (auditResult === undefined || auditReport === undefined) {
  process.stderr.write(auditResult?.stderr ?? "");
  throw new Error("npm audit did not return a complete report after three attempts");
}

const lockMetadataRemediations = new Map([
  [
    "brace-expansion",
    {
      node: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
      advisoryUrls: new Set([
        "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
        "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
        "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
      ]),
      installedVersion: "5.0.9",
    },
  ],
  [
    "undici",
    {
      node: "node_modules/@earendil-works/pi-coding-agent/node_modules/undici",
      advisoryUrls: new Set([
        "https://github.com/advisories/GHSA-8xcm-r25x-g524",
        "https://github.com/advisories/GHSA-4cwx-7wf7-3272",
        "https://github.com/advisories/GHSA-m8rv-5g2x-5cg5",
        "https://github.com/advisories/GHSA-jr45-8vmc-qm54",
        "https://github.com/advisories/GHSA-v3r7-h72x-cjcm",
      ]),
      installedVersion: "8.10.0",
    },
  ],
  [
    "protobufjs",
    {
      node: "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs",
      advisoryUrls: new Set(["https://github.com/advisories/GHSA-j3f2-48v5-ccww"]),
      installedVersion: "7.6.5",
    },
  ],
  [
    "find-my-way",
    {
      node: "node_modules/@nestjs/platform-fastify/node_modules/find-my-way",
      advisoryUrls: new Set(["https://github.com/advisories/GHSA-c96f-x56v-gq3h"]),
      installedVersion: "9.7.0",
    },
  ],
]);

const remediated = [];
const remaining = [];
for (const [name, vulnerability] of Object.entries(auditReport.vulnerabilities ?? {})) {
  const remediation = lockMetadataRemediations.get(name);
  const advisoryUrls = (vulnerability.via ?? [])
    .filter((item) => item && typeof item === "object")
    .map((item) => item.url);
  const isExactShrinkwrapFalsePositive =
    remediation !== undefined &&
    JSON.parse(readFileSync(join(repositoryRoot, remediation.node, "package.json"), "utf8"))
      .version === remediation.installedVersion &&
    Array.isArray(vulnerability.nodes) &&
    vulnerability.nodes.length === 1 &&
    vulnerability.nodes[0] === remediation.node &&
    advisoryUrls.length === remediation.advisoryUrls.size &&
    advisoryUrls.every((url) => remediation.advisoryUrls.has(url));

  if (isExactShrinkwrapFalsePositive) {
    remediated.push({
      name,
      advisoryUrls: [...remediation.advisoryUrls],
      installedVersion: remediation.installedVersion,
      reason:
        "Published lock metadata records a vulnerable transitive version, but the installed package is replaced and verified after npm ci",
    });
  } else if (
    name === "@nestjs/platform-fastify" &&
    Array.isArray(vulnerability.via) &&
    vulnerability.via.length === 1 &&
    vulnerability.via[0] === "find-my-way" &&
    lockMetadataRemediations.has("find-my-way")
  ) {
    remediated.push({
      name,
      advisoryUrls: ["https://github.com/advisories/GHSA-c96f-x56v-gq3h"],
      installedVersion: "11.1.28",
      reason:
        "The aggregate finding is caused only by find-my-way, whose installed nested package is replaced and verified after npm ci",
    });
  } else if (
    name === "@earendil-works/pi-coding-agent" &&
    Array.isArray(vulnerability.via) &&
    vulnerability.via.length === 1 &&
    vulnerability.via[0] === "undici" &&
    lockMetadataRemediations.has("undici")
  ) {
    remediated.push({
      name,
      advisoryUrls: [...lockMetadataRemediations.get("undici").advisoryUrls],
      installedVersion: "0.84.1",
      reason:
        "The aggregate finding is caused only by undici, whose installed nested package is replaced and verified after npm ci",
    });
  } else {
    remaining.push({ name, ...vulnerability });
  }
}

const blockingSeverities = new Set(["high", "critical"]);
const blocking = remaining.filter((vulnerability) =>
  blockingSeverities.has(vulnerability.severity),
);

console.log(
  JSON.stringify({
    securityAuditPassed: blocking.length === 0,
    auditLevel: "high",
    remediatedShrinkwrapFindings: remediated,
    remainingVulnerabilities: remaining.map((vulnerability) => ({
      name: vulnerability.name,
      severity: vulnerability.severity,
      nodes: vulnerability.nodes,
    })),
  }),
);

if (blocking.length > 0) {
  process.stderr.write(auditResult.stderr);
  process.exit(1);
}

if (auditResult.status !== 0 && remediated.length === 0) {
  process.stderr.write(auditResult.stderr);
  process.exit(auditResult.status ?? 1);
}
