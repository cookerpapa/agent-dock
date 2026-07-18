import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  EmbeddedPiBackend,
  createPortableCounterExtension,
  type PortableCounterActivity,
} from "./index.ts";

const LOGICAL_SESSION_COUNT = 1_000;
const ACTIVE_SESSION_COUNT = 10;
const ACTIVATION_DELAY_MS = 250;
const root = await mkdtemp(join(tmpdir(), "agent-dock-density-probe-"));
let measureCommandConcurrency = false;
let activeCommands = 0;
let peakActiveCommands = 0;

function observe(activity: PortableCounterActivity): void {
  if (!measureCommandConcurrency) {
    return;
  }
  if (activity.phase === "command_started") {
    activeCommands += 1;
    peakActiveCommands = Math.max(peakActiveCommands, activeCommands);
  }
  if (activity.phase === "command_finished") {
    activeCommands -= 1;
  }
}

function collectMemory(): NodeJS.MemoryUsage {
  global.gc?.();
  return process.memoryUsage();
}

function bytesPerSession(delta: number): number {
  return Math.round(delta / LOGICAL_SESSION_COUNT);
}

async function waitForActiveCount(
  backend: EmbeddedPiBackend,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.metrics.activeActivations === expected && activeCommands === expected) {
      return;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 5);
    });
  }
  throw new Error(
    `Timed out waiting for ${expected} active sessions; activation=${backend.metrics.activeActivations}, command=${activeCommands}`,
  );
}

const backend = new EmbeddedPiBackend({
  cwd: join(root, "workspace"),
  agentDir: join(root, "agent-home"),
  sessionDir: join(root, "sessions"),
  maxConcurrentActivations: ACTIVE_SESSION_COUNT,
  extensionFactories: [createPortableCounterExtension(observe)],
});

try {
  const memoryBefore = collectMemory();
  const createStartedAt = performance.now();

  for (let offset = 0; offset < LOGICAL_SESSION_COUNT; offset += ACTIVE_SESSION_COUNT) {
    const batchSize = Math.min(ACTIVE_SESSION_COUNT, LOGICAL_SESSION_COUNT - offset);
    await Promise.all(
      Array.from({ length: batchSize }, (_, index) =>
        backend.execute({
          logicalSessionId: `density-session-${offset + index}`,
          command: "/portable-counter",
        }),
      ),
    );
  }

  const createDurationMs = Math.round(performance.now() - createStartedAt);
  const idleMemory = collectMemory();
  assert.equal(backend.metrics.knownSessionCount, LOGICAL_SESSION_COUNT);
  assert.equal(backend.metrics.activeActivations, 0);
  assert.equal(backend.metrics.sessionLaneCount, 0);

  measureCommandConcurrency = true;
  const activeRuns = Array.from({ length: ACTIVE_SESSION_COUNT }, (_, index) =>
    backend.execute({
      logicalSessionId: `density-session-${index}`,
      command: `/portable-counter ${ACTIVATION_DELAY_MS}`,
    }),
  );
  await waitForActiveCount(backend, ACTIVE_SESSION_COUNT);
  const activeMemory = collectMemory();
  await Promise.all(activeRuns);
  measureCommandConcurrency = false;

  const settledMemory = collectMemory();
  assert.equal(peakActiveCommands, ACTIVE_SESSION_COUNT);
  assert.equal(backend.metrics.peakActiveActivations, ACTIVE_SESSION_COUNT);
  assert.equal(backend.metrics.activeActivations, 0);
  assert.equal(backend.metrics.sessionLaneCount, 0);

  process.stdout.write(
    `${JSON.stringify(
      {
        result: "passed",
        piVersion: "0.80.10",
        workerPid: process.pid,
        logicalSessions: LOGICAL_SESSION_COUNT,
        concurrentlyActiveSessions: ACTIVE_SESSION_COUNT,
        createAndCoolDurationMs: createDurationMs,
        amortizedWallTimePerSessionMs: Number(
          (createDurationMs / LOGICAL_SESSION_COUNT).toFixed(2),
        ),
        memoryBytes: {
          before: {
            rss: memoryBefore.rss,
            heapUsed: memoryBefore.heapUsed,
          },
          after1000Idle: {
            rss: idleMemory.rss,
            heapUsed: idleMemory.heapUsed,
          },
          while10Active: {
            rss: activeMemory.rss,
            heapUsed: activeMemory.heapUsed,
          },
          after10Settle: {
            rss: settledMemory.rss,
            heapUsed: settledMemory.heapUsed,
          },
          idleDelta: {
            rss: idleMemory.rss - memoryBefore.rss,
            heapUsed: idleMemory.heapUsed - memoryBefore.heapUsed,
          },
          approximateIdleDeltaPerLogicalSession: {
            rss: bytesPerSession(idleMemory.rss - memoryBefore.rss),
            heapUsed: bytesPerSession(idleMemory.heapUsed - memoryBefore.heapUsed),
          },
        },
        peakActivePiRuntimes: backend.metrics.peakActiveActivations,
        activePiRuntimesAfterSettle: backend.metrics.activeActivations,
        sessionLanesAfterSettle: backend.metrics.sessionLaneCount,
        modelCalls: 0,
        executionMode: "embedded-sdk",
        note: "RSS includes allocator high-water pages and Pi/module caches; heap delta is more useful than treating RSS as per-session live runtime memory.",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
