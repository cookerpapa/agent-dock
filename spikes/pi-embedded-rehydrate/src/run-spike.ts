import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddedPiBackend,
  createPortableCounterExtension,
  readPortableCounter,
  type PortableCounterActivity,
} from "./index.ts";

const uid = process.getuid?.() ?? null;
const gid = process.getgid?.() ?? null;
const nonRootRequired = process.env.AGENT_DOCK_REQUIRE_NON_ROOT === "1";
const nonRoot = uid !== null && uid !== 0;
if (nonRootRequired && !nonRoot) {
  throw new Error("The embedded rehydrate spike must run as a non-root Unix user");
}
const runtimeIdentity = { uid, gid, nonRoot, nonRootRequired };

const root = await mkdtemp(join(tmpdir(), "agent-dock-embedded-spike-"));
const activeBySession = new Map<string, number>();
let activeGlobal = 0;
let peakGlobal = 0;
let peakSameSession = 0;
let shutdownCount = 0;

function observe(activity: PortableCounterActivity): void {
  if (activity.phase === "shutdown") {
    shutdownCount += 1;
  }
  if (activity.phase === "command_started") {
    activeGlobal += 1;
    peakGlobal = Math.max(peakGlobal, activeGlobal);
    const active = (activeBySession.get(activity.piSessionId) ?? 0) + 1;
    activeBySession.set(activity.piSessionId, active);
    peakSameSession = Math.max(peakSameSession, active);
  }
  if (activity.phase === "command_finished") {
    activeGlobal -= 1;
    activeBySession.set(activity.piSessionId, (activeBySession.get(activity.piSessionId) ?? 1) - 1);
  }
}

const options = {
  cwd: join(root, "workspace"),
  agentDir: join(root, "agent-home"),
  sessionDir: join(root, "sessions"),
  maxConcurrentActivations: 2,
  extensionFactories: [createPortableCounterExtension(observe)],
};

try {
  const firstBackend = new EmbeddedPiBackend(options);
  const firstA = await firstBackend.execute({
    logicalSessionId: "session-a",
    command: "/portable-counter",
  });
  const firstB = await firstBackend.execute({
    logicalSessionId: "session-b",
    command: "/portable-counter",
  });
  const secondA = await firstBackend.execute({
    logicalSessionId: "session-a",
    command: "/portable-counter",
  });

  assert.equal(readPortableCounter(firstA.entries), 1);
  assert.equal(readPortableCounter(firstB.entries), 1);
  assert.equal(readPortableCounter(secondA.entries), 2);
  assert.equal(secondA.restoredMessageCount, 1);
  assert.equal(firstA.workerPid, firstB.workerPid);
  assert.equal(firstA.workerPid, secondA.workerPid);

  // A fresh backend instance receives only the durable checkpoint. This resets
  // its in-memory lane and checkpoint maps while keeping the same test process.
  const replacementBackend = new EmbeddedPiBackend(options);
  const thirdA = await replacementBackend.execute({
    logicalSessionId: "session-a",
    command: "/portable-counter",
    checkpoint: secondA.checkpoint,
  });
  assert.notEqual(thirdA.backendInstanceId, secondA.backendInstanceId);
  assert.equal(thirdA.piSessionId, firstA.piSessionId);
  assert.equal(thirdA.restoredMessageCount, 1);
  assert.deepEqual(thirdA.restoredMessageRoles, ["assistant"]);
  assert.equal(readPortableCounter(thirdA.entries), 3);

  const [secondB, firstC] = await Promise.all([
    replacementBackend.execute({
      logicalSessionId: "session-b",
      command: "/portable-counter 80",
      checkpoint: firstB.checkpoint,
    }),
    replacementBackend.execute({
      logicalSessionId: "session-c",
      command: "/portable-counter 80",
    }),
  ]);
  assert.equal(readPortableCounter(secondB.entries), 2);
  assert.equal(readPortableCounter(firstC.entries), 1);

  const [fourthA, fifthA] = await Promise.all([
    replacementBackend.execute({
      logicalSessionId: "session-a",
      command: "/portable-counter 40",
    }),
    replacementBackend.execute({
      logicalSessionId: "session-a",
      command: "/portable-counter",
    }),
  ]);
  assert.deepEqual(
    [readPortableCounter(fourthA.entries), readPortableCounter(fifthA.entries)],
    [4, 5],
  );
  assert.equal(peakGlobal, 2);
  assert.equal(peakSameSession, 1);
  assert.equal(firstBackend.metrics.activeActivations, 0);
  assert.equal(replacementBackend.metrics.activeActivations, 0);
  assert.equal(replacementBackend.metrics.sessionLaneCount, 0);
  assert.equal(shutdownCount, 8);

  process.stdout.write(
    `${JSON.stringify(
      {
        result: "passed",
        piVersion: "0.84.1",
        runtimeIdentity,
        workerPid: process.pid,
        logicalSessionsExercised: 3,
        sessionACounterAfterRehydrate: readPortableCounter(fifthA.entries),
        sessionARestoredMessagesBeforeThirdActivation: thirdA.restoredMessageCount,
        backendReplacementUsedCheckpointOnly: true,
        peakCrossSessionActivations: peakGlobal,
        peakSameSessionActivations: peakSameSession,
        allActivationsDisposed: replacementBackend.metrics.activeActivations === 0,
        extensionShutdownEvents: shutdownCount,
        modelCalls: 0,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
