import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { classifyStructuredTestCommand } from "../packages/control-plane/src/structured-test-command.ts";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-manager/src/index.ts";
import { AgentDockApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.AGENT_DOCK_LIVE_PARALLEL_CHECK !== "1") {
  throw new Error(
    "Set AGENT_DOCK_LIVE_PARALLEL_CHECK=1 to acknowledge real model and Cube KVM usage",
  );
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);

async function readPrivate(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new Error(`${label} is not a private bounded file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

const environment = Object.fromEntries(
  (await readPrivate(resolve(runtimeDirectory, ".env"), 64 * 1_024, "Production environment"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.AGENT_DOCK_HTTP_BIND_ADDRESS;
const port = environment.AGENT_DOCK_HTTP_PORT;
const tenantId = environment.AGENT_DOCK_TENANT_ID;
if (bindAddress === undefined || port === undefined || tenantId === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const token = (await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8")).trim();
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);
const api = new AgentDockApi(fetchFromProduction, token);
const cubeCluster = parseJson(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/cluster.json"),
    64 * 1_024,
    "Cube cluster evidence",
  ),
  "Cube cluster evidence",
);
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cubeCluster.api.host}:${String(cubeCluster.api.port)}`,
  apiKey: (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/cubesandbox-api-key"),
      4_096,
      "Cube API key",
    )
  ).replace(/\r?\n$/, ""),
  proxyNodeIp: cubeCluster.proxy.host,
  proxyPort: cubeCluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cubeCluster.sandboxDomain,
  egressProxyIp: environment.AGENT_DOCK_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
  requestTimeoutMs: 30_000,
});
const executionEnvironment = {
  ...process.env,
  NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
};
const terminalRunStates = new Set(["completed", "failed", "cancelled", "timed_out", "superseded"]);
const terminalRaceStates = new Set(["awaiting_decision", "completed", "failed", "cancelled"]);

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: executionEnvironment,
        encoding: "utf8",
        maxBuffer: 1_024 * 1_024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`${command} failed: ${stderr.trim().slice(-2_000) || error.message}`, {
              cause: error,
            }),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function psql(query) {
  return capture(process.execPath, [
    "scripts/production-compose.mjs",
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username",
    "agent_dock",
    "--dbname",
    "agent_dock",
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

async function waitForRun(runId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const run = await api.getRun(runId);
    if (terminalRunStates.has(run.state)) return run;
    if (Date.now() >= deadline) throw new Error(`Run ${runId} timed out`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

function effectiveTestResults(tests) {
  const latestByInvocation = new Map();
  for (const test of tests) {
    const invocation = classifyStructuredTestCommand(test.command);
    if (invocation !== undefined) latestByInvocation.set(invocation.key, test);
  }
  return [...latestByInvocation.values()];
}

function managedCubeForSession(instances, sessionId) {
  return instances.filter(
    (instance) =>
      instance.metadata["agentdock.managed"] === "true" &&
      instance.metadata["agentdock.provider"] === "cubesandbox" &&
      instance.metadata["agentdock.session_id"] === sessionId,
  );
}

function cubeIdentity(instance, sessionId) {
  const metadata = instance.metadata;
  assert.equal(metadata["agentdock.session_id"], sessionId);
  for (const value of [
    instance.sandboxId,
    metadata["agentdock.activation_id"],
    metadata["agentdock.sandbox_id"],
  ]) {
    assert.equal(typeof value, "string");
    assert(value.length > 0);
  }
  return {
    nativeSandboxId: instance.sandboxId,
    activationId: metadata["agentdock.activation_id"],
    supervisorSandboxId: metadata["agentdock.sandbox_id"],
    runtime: "cubesandbox-kvm",
  };
}

async function cleanupSession(sessionId, strict) {
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const instances = managedCubeForSession(await cube.list(), sessionId);
      if (instances.length === 0) return 0;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error("Candidate Session retained a Cube microVM");
  } catch (error) {
    if (strict) throw error;
    return 0;
  }
}

await cube.checkHealth();
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");
const suffix = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
const project = await api.createProject(`Parallel candidate acceptance ${suffix}`);
const parent = await api.createSession(
  project.projectId,
  project.workspaceId,
  `Parallel candidate acceptance ${suffix}`,
);
const sessionsForCleanup = new Set([parent.sessionId]);
const checkedAt = new Date().toISOString();

try {
  const seedSubmittedAt = performance.now();
  const seedAccepted = await api.acceptTurn(
    parent.sessionId,
    [
      "Work only in the current sample Java workspace.",
      "Fix Calculator.add so it returns the sum of its two arguments.",
      "Change only src/Calculator.java.",
      "Run ./eval/test.sh add and do not finish until it passes.",
    ].join(" "),
    newIdempotencyKey("parallel-seed"),
    "off",
  );
  const seedRun = await waitForRun(seedAccepted.runId);
  const seedSettledMs = Math.round(performance.now() - seedSubmittedAt);
  assert.equal(seedRun.state, "completed", JSON.stringify(seedRun.failure));
  const seedUsage = await api.getRunUsage(seedAccepted.runId);
  const seedBundle = await api.getRunReviewBundle(seedAccepted.runId);
  assert(seedBundle.manifest.tests.some((test) => test.status === "passed"));
  const parentBeforeRace = await api.listWorkspaceVersions(parent.sessionId);
  assert(parentBeforeRace.currentVersionId !== undefined);
  const baseWorkspaceVersionId = parentBeforeRace.currentVersionId;

  const raceStartedAt = performance.now();
  let race = await api.createCandidateRace(
    parent.sessionId,
    {
      baseWorkspaceVersionId,
      prompt: [
        "Work only in the current sample Java workspace.",
        "Fix Calculator.subtract so Calculator.subtract(7, 3) returns 4.",
        "Change only src/Calculator.java; do not edit eval or test files.",
        "Run ./eval/test.sh subtract and do not finish until it passes.",
      ].join(" "),
      candidates: [
        {
          label: "Minimal patch",
          strategy:
            "Inspect the existing method and apply the smallest correct expression-only repair.",
        },
        {
          label: "Verification first",
          strategy:
            "Inspect the existing regression test first, then implement the simplest repair that satisfies it.",
        },
      ],
      maximumConcurrentCandidates: 2,
      thinkingLevel: "off",
      acceptance: {
        requirePatch: true,
        requireTests: true,
        maximumChangedPaths: 1,
        protectedPathPrefixes: ["eval/", "test/"],
      },
    },
    newIdempotencyKey("parallel-race"),
  );
  for (const candidate of race.candidates) sessionsForCleanup.add(candidate.sessionId);

  const observedSandboxes = new Map();
  let simultaneousCandidateSandboxes = false;
  const raceDeadline = Date.now() + 900_000;
  while (!terminalRaceStates.has(race.state)) {
    const instances = await cube.list();
    let activeCandidateMicroVms = 0;
    for (const candidate of race.candidates) {
      const matches = managedCubeForSession(instances, candidate.sessionId);
      if (matches.length > 1) throw new Error("Candidate Session owns multiple Tool Sandboxes");
      if (matches.length === 1) {
        activeCandidateMicroVms += 1;
        observedSandboxes.set(candidate.candidateId, cubeIdentity(matches[0], candidate.sessionId));
      }
    }
    if (activeCandidateMicroVms === race.candidates.length) {
      simultaneousCandidateSandboxes = true;
    }
    if (Date.now() >= raceDeadline) throw new Error("Candidate race timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    race = await api.getCandidateRace(race.orchestrationId);
  }
  const raceSettledMs = Math.round(performance.now() - raceStartedAt);

  assert.equal(race.state, "awaiting_decision", JSON.stringify(race.candidates));
  assert.equal(race.candidates.length, 2);
  assert(
    race.candidates.every(
      (candidate) =>
        candidate.runState === "completed" && candidate.acceptance?.verdict === "passed",
    ),
    JSON.stringify(race.candidates),
  );
  assert.equal(observedSandboxes.size, 2, "Both candidates did not enter Cube KVM");
  assert(
    simultaneousCandidateSandboxes,
    "Both candidate Tool Sandboxes were never observed simultaneously",
  );
  assert.equal(
    new Set([...observedSandboxes.values()].map((sandbox) => sandbox.nativeSandboxId)).size,
    2,
    "Candidate Sessions reused one physical Cube microVM",
  );
  assert.equal(
    new Set([...observedSandboxes.values()].map((sandbox) => sandbox.activationId)).size,
    2,
    "Candidate Sessions reused one Tool Sandbox activation",
  );
  const sharedTrustedSupervisor =
    new Set([...observedSandboxes.values()].map((sandbox) => sandbox.supervisorSandboxId)).size ===
    1;

  const candidateEvidence = await Promise.all(
    race.candidates.map(async (candidate) => {
      const run = await api.getRun(candidate.runId);
      const usage = await api.getRunUsage(candidate.runId);
      const bundle = await api.getRunReviewBundle(candidate.runId);
      const repeated = await api.getRunReviewBundle(candidate.runId);
      assert.equal(repeated.manifestSha256, bundle.manifestSha256);
      assert.equal(run.state, "completed");
      assert(run.startedAt !== undefined && run.settledAt !== undefined);
      assert.deepEqual(bundle.manifest.changes.changedPaths, ["src/Calculator.java"]);
      assert(bundle.manifest.tests.length > 0);
      assert(
        bundle.manifest.tests.every(
          (test) => classifyStructuredTestCommand(test.command) !== undefined,
        ),
      );
      const effectiveTests = effectiveTestResults(bundle.manifest.tests);
      assert(effectiveTests.length > 0);
      assert(effectiveTests.every((test) => test.status === "passed"));
      return {
        candidateId: candidate.candidateId,
        label: candidate.label,
        sessionId: candidate.sessionId,
        runId: candidate.runId,
        workspaceVersionId: candidate.workspaceVersionId,
        startedAt: run.startedAt,
        settledAt: run.settledAt,
        acceptance: candidate.acceptance,
        reviewBundleId: bundle.reviewBundleId,
        reviewBundleSha256: bundle.manifestSha256,
        changedPaths: bundle.manifest.changes.changedPaths,
        tests: bundle.manifest.tests.map((test) => ({
          command: test.command,
          suite: test.suite,
          status: test.status,
        })),
        effectiveTests: effectiveTests.map((test) => ({
          command: test.command,
          suite: test.suite,
          status: test.status,
        })),
        usage: usage.totals,
        sandbox: observedSandboxes.get(candidate.candidateId),
      };
    }),
  );
  const latestStart = Math.max(
    ...candidateEvidence.map((candidate) => new Date(candidate.startedAt).valueOf()),
  );
  const earliestSettlement = Math.min(
    ...candidateEvidence.map((candidate) => new Date(candidate.settledAt).valueOf()),
  );
  assert(latestStart < earliestSettlement, "Candidate Run execution intervals did not overlap");

  assert(race.recommendedCandidateId !== undefined);
  const recommended = race.candidates.find(
    (candidate) => candidate.candidateId === race.recommendedCandidateId,
  );
  assert(recommended?.workspaceVersionId !== undefined);
  const promoted = await api.promoteCandidate(
    race.orchestrationId,
    recommended.candidateId,
    baseWorkspaceVersionId,
    newIdempotencyKey("parallel-promote"),
  );
  assert.equal(promoted.state, "completed");
  assert.equal(promoted.winnerCandidateId, recommended.candidateId);
  assert(promoted.promotedWorkspaceVersionId !== undefined);
  const parentAfterPromotion = await api.listWorkspaceVersions(parent.sessionId);
  assert.equal(parentAfterPromotion.currentVersionId, promoted.promotedWorkspaceVersionId);
  const promotedVersion = await api.getWorkspaceVersion(promoted.promotedWorkspaceVersionId);
  assert.equal(promotedVersion.origin, "promotion");
  assert.equal(promotedVersion.sourceVersionId, recommended.workspaceVersionId);
  const piArtifactPreserved = await psql(
    `select (base.pi_artifact_id = promoted.pi_artifact_id)::text
       from workspace_versions as base
       join workspace_versions as promoted
         on promoted.tenant_id = base.tenant_id
      where base.tenant_id = ${sqlLiteral(tenantId)}
        and base.id = ${sqlLiteral(baseWorkspaceVersionId)}
        and promoted.id = ${sqlLiteral(promoted.promotedWorkspaceVersionId)}`,
  );
  assert.equal(piArtifactPreserved, "true");

  const cleanedSandboxes = [];
  for (const sessionId of sessionsForCleanup) {
    cleanedSandboxes.push({ sessionId, count: await cleanupSession(sessionId, true) });
  }
  const report = {
    accepted: true,
    checkedAt,
    endpoint: baseUrl.toString(),
    model: { provider: model.provider, modelId: model.modelId },
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    parentSessionId: parent.sessionId,
    baseWorkspaceVersionId,
    seed: {
      runId: seedAccepted.runId,
      settledMs: seedSettledMs,
      reviewBundleId: seedBundle.reviewBundleId,
      usage: seedUsage.totals,
    },
    race: {
      orchestrationId: race.orchestrationId,
      maximumConcurrentCandidates: race.maximumConcurrentCandidates,
      settledMs: raceSettledMs,
      simultaneousCandidateSandboxes,
      executionIntervalsOverlapped: true,
      sharedTrustedSupervisor,
      candidates: candidateEvidence,
      recommendedCandidateId: race.recommendedCandidateId,
    },
    promotion: {
      winnerCandidateId: promoted.winnerCandidateId,
      promotedWorkspaceVersionId: promoted.promotedWorkspaceVersionId,
      sourceWorkspaceVersionId: promotedVersion.sourceVersionId,
      parentPiArtifactPreserved: true,
      decisionGate: promoted.decisionGate.state,
    },
    cleanup: {
      sessions: cleanedSandboxes,
      exactAssignmentsDestroyed: true,
    },
  };
  const reportDirectory = resolve(repositoryRoot, "docs/reports");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "parallel-candidate-race-acceptance-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  const candidateLines = report.race.candidates.map(
    (candidate) =>
      `- ${candidate.label}: ${String(candidate.usage.requests)} model requests, ` +
      `${String(candidate.usage.inputTokens)}/${String(candidate.usage.outputTokens)} input/output tokens, ` +
      `${String(candidate.tests.length)} test attempt(s) / ` +
      `${String(candidate.effectiveTests.length)} green effective result(s), ` +
      `Cube microVM ${candidate.sandbox.nativeSandboxId}, activation ${candidate.sandbox.activationId}`,
  );
  await writeFile(
    resolve(reportDirectory, "parallel-candidate-race-acceptance-latest.md"),
    [
      "# Parallel candidate race production acceptance",
      "",
      `- Checked at: ${report.checkedAt}`,
      `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
      `- Candidate concurrency: ${String(report.race.maximumConcurrentCandidates)}`,
      `- Candidate execution intervals overlapped: ${String(report.race.executionIntervalsOverlapped)}`,
      `- Distinct Cube KVM guests observed simultaneously: ${String(report.race.simultaneousCandidateSandboxes)}`,
      `- Shared trusted Supervisor with isolated Tool activations: ${String(report.race.sharedTrustedSupervisor)}`,
      ...candidateLines,
      `- Recommended/promoted candidate: ${report.promotion.winnerCandidateId}`,
      `- Promotion preserved parent Pi context: ${String(report.promotion.parentPiArtifactPreserved)}`,
      `- Exact Sandbox cleanup: ${String(report.cleanup.exactAssignmentsDestroyed)}`,
      "",
      "One immutable parent Workspace was forked into two child Sessions. Both Runs executed concurrently in distinct Cube KVM microVMs, produced immutable Review Bundles with green tests, passed deterministic acceptance, and remained isolated until an explicit CAS promotion copied only the selected Workspace into the parent Session.",
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  for (const sessionId of sessionsForCleanup) await cleanupSession(sessionId, false);
  await cube.close();
}
