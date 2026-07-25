import { execFileSync, spawnSync } from "node:child_process";
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

const auditResult = spawnSync(npmCommand, ["audit", "--json", "--audit-level=high"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (auditResult.error) {
  throw auditResult.error;
}

let auditReport;
try {
  auditReport = JSON.parse(auditResult.stdout);
} catch {
  process.stderr.write(auditResult.stderr);
  throw new Error("npm audit did not return a JSON report");
}

const lockMetadataRemediations = new Map([
  [
    "brace-expansion",
    {
      node: "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
      advisoryUrls: new Set([
        "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
        "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
      ]),
      installedVersion: "5.0.8",
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
