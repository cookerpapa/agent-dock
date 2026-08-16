import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const argumentsList = process.argv.slice(2);

function argument(name, fallback) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return fallback;
  const value = argumentsList[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "eval/fault-cases.json"), "utf8"),
);
if (manifest.format !== "pi-cloud.fault-eval.v1" || !Array.isArray(manifest.cases)) {
  throw new Error("Fault evaluation manifest is invalid");
}
const outputJson = resolve(
  repositoryRoot,
  argument("--output", "docs/reports/fault-eval-latest.json"),
);
const outputMarkdown = outputJson.replace(/\.json$/, ".md");

function executeCase(faultCase) {
  return new Promise((resolvePromise) => {
    const startedAt = performance.now();
    const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const testPattern = [...(faultCase.setupTests ?? []), faultCase.test]
      .map(escapeRegularExpression)
      .join("|");
    const child = spawn(
      "npm",
      ["run", "test", "--workspace", faultCase.workspace, "--", faultCase.file, "-t", testPattern],
      {
        cwd: repositoryRoot,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const collect = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 64_000) output = output.slice(-64_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      resolvePromise({
        id: faultCase.id,
        success: false,
        invariant: faultCase.invariant,
        durationMs: Math.round(performance.now() - startedAt),
        failure: error.message,
      });
    });
    child.once("exit", (code, signal) => {
      const success = code === 0;
      resolvePromise({
        id: faultCase.id,
        success,
        invariant: faultCase.invariant,
        durationMs: Math.round(performance.now() - startedAt),
        ...(success
          ? {}
          : {
              failure: `exit=${String(code)}, signal=${String(signal)}`,
              outputTail: output.trim().slice(-4_000),
            }),
      });
    });
  });
}

const results = [];
for (const faultCase of manifest.cases) {
  const result = await executeCase(faultCase);
  results.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
const percentile = (fraction) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)];
const successful = results.filter((result) => result.success).length;
const report = {
  format: "pi-cloud.fault-eval-report.v1",
  generatedAt: new Date().toISOString(),
  methodology: "deterministic_targeted_fault_injection",
  liveChaosExperiment: false,
  caseCount: results.length,
  successful,
  successRate: results.length === 0 ? 0 : successful / results.length,
  p50DurationMs: percentile(0.5),
  p95DurationMs: percentile(0.95),
  results,
};
const markdown =
  `# PiCloud deterministic fault evaluation\n\n` +
  `Generated: ${report.generatedAt}\n\n` +
  `These are targeted, deterministic fault injections against the durable execution protocol. ` +
  `They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.\n\n` +
  `- Cases: ${report.caseCount}\n` +
  `- Invariants preserved: ${report.successful}/${report.caseCount} (${(report.successRate * 100).toFixed(1)}%)\n` +
  `- p50 / p95: ${report.p50DurationMs} ms / ${report.p95DurationMs} ms\n\n` +
  `| Fault | Result | Protected invariant | Duration |\n` +
  `| --- | --- | --- | ---: |\n` +
  results
    .map(
      (result) =>
        `| ${result.id} | ${result.success ? "pass" : "fail"} | ${result.invariant} | ${result.durationMs} ms |`,
    )
    .join("\n") +
  `\n`;

await mkdir(dirname(outputJson), { recursive: true });
await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(outputMarkdown, markdown, "utf8");
if (successful !== results.length) process.exitCode = 1;
