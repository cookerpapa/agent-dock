import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { EmbeddedPiBackend, createPortableCounterExtension } from "./index.ts";

const SAMPLE_COUNT = 20;
const TIMEOUT_MS = 10_000;

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(quantile * ordered.length) - 1));
  return Number((ordered[index] ?? 0).toFixed(2));
}

function summarize(values: number[]): {
  minimumMs: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
} {
  return {
    minimumMs: Number(Math.min(...values).toFixed(2)),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maximumMs: Number(Math.max(...values).toFixed(2)),
  };
}

function piRpcEntry(): string {
  const packageJson = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  if (packageJson === undefined) {
    throw new Error("Pinned Pi RPC package is unavailable");
  }
  return resolve(dirname(packageJson), "dist/rpc-entry.js");
}

async function rpcReadyDuration(root: string, sample: number): Promise<number> {
  const agentDir = join(root, `rpc-agent-${sample}`);
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [
      piRpcEntry(),
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-tools",
    ],
    {
      cwd: root,
      env: {
        HOME: root,
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  const result = await new Promise<number>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("Pi RPC readiness benchmark timed out"));
    }, TIMEOUT_MS);
    const reject = (error: Error): void => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    child.once("error", reject);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd < 0) return;
      try {
        const message = JSON.parse(stdout.slice(0, lineEnd)) as {
          type?: unknown;
          command?: unknown;
          success?: unknown;
        };
        assert.equal(message.type, "response");
        assert.equal(message.command, "get_state");
        assert.equal(message.success, true);
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error("Invalid Pi RPC response"));
        return;
      }
      clearTimeout(timer);
      resolvePromise(performance.now() - startedAt);
    });
    child.once("close", (code, signal) => {
      if (stdout.includes("\n")) return;
      reject(
        new Error(
          `Pi RPC exited before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ),
      );
    });
    child.stdin.end(`${JSON.stringify({ type: "get_state" })}\n`);
  });

  if (!child.killed) child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 1_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  return result;
}

const root = await mkdtemp(join(tmpdir(), "agent-dock-runtime-benchmark-"));
try {
  const backend = new EmbeddedPiBackend({
    cwd: join(root, "workspace"),
    agentDir: join(root, "sdk-agent"),
    sessionDir: join(root, "sdk-sessions"),
    maxConcurrentActivations: 1,
    extensionFactories: [createPortableCounterExtension()],
  });

  // Warm module and filesystem caches before collecting either sample set.
  await backend.execute({
    logicalSessionId: "sdk-warmup",
    command: "/portable-counter",
  });
  await rpcReadyDuration(root, -1);

  const sdkDurations: number[] = [];
  const rpcDurations: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    await backend.execute({
      logicalSessionId: `sdk-sample-${sample}`,
      command: "/portable-counter",
    });
    sdkDurations.push(performance.now() - startedAt);
    rpcDurations.push(await rpcReadyDuration(root, sample));
  }

  assert.equal(backend.metrics.activeActivations, 0);
  const sdk = summarize(sdkDurations);
  const rpc = summarize(rpcDurations);
  process.stdout.write(
    `${JSON.stringify(
      {
        result: "passed",
        piVersion: "0.84.1",
        sampleCount: SAMPLE_COUNT,
        modelCalls: 0,
        sdkActivationIncludingExtensionCommandAndDispose: sdk,
        rpcSubprocessStartupThroughGetState: rpc,
        p50DifferenceMs: Number((rpc.p50Ms - sdk.p50Ms).toFixed(2)),
        decisionBoundary: {
          sdkStrengths: ["lower activation overhead", "typed direct state and event access"],
          rpcStrengths: [
            "hard process-group cancellation",
            "per-Run environment isolation",
            "bounded crash and extension failure domain",
          ],
          productionSwitchRequires:
            "SDK parity for remote tools, native compaction, forced cancellation, per-Run configuration isolation, and one-Run Worker replacement.",
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
