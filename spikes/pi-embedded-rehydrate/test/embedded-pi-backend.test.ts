import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EmbeddedPiBackend,
  createPortableCounterExtension,
  readPortableCounter,
  type EmbeddedPiBackendOptions,
  type PortableCounterActivity,
} from "../src/index.ts";

type ActivityTracker = {
  observe: (activity: PortableCounterActivity) => void;
  peakGlobal: () => number;
  peakForSession: (piSessionId: string) => number;
  rehydratedValues: (piSessionId: string) => number[];
  shutdownCount: () => number;
};

function createActivityTracker(): ActivityTracker {
  let activeGlobal = 0;
  let observedPeakGlobal = 0;
  let observedShutdownCount = 0;
  const activeBySession = new Map<string, number>();
  const peakBySession = new Map<string, number>();
  const restoredBySession = new Map<string, number[]>();

  return {
    observe(activity) {
      if (activity.phase === "rehydrated") {
        const values = restoredBySession.get(activity.piSessionId) ?? [];
        values.push(activity.value);
        restoredBySession.set(activity.piSessionId, values);
      }
      if (activity.phase === "shutdown") {
        observedShutdownCount += 1;
      }
      if (activity.phase === "command_started") {
        activeGlobal += 1;
        observedPeakGlobal = Math.max(observedPeakGlobal, activeGlobal);
        const active = (activeBySession.get(activity.piSessionId) ?? 0) + 1;
        activeBySession.set(activity.piSessionId, active);
        peakBySession.set(
          activity.piSessionId,
          Math.max(peakBySession.get(activity.piSessionId) ?? 0, active),
        );
      }
      if (activity.phase === "command_finished") {
        activeGlobal -= 1;
        activeBySession.set(
          activity.piSessionId,
          (activeBySession.get(activity.piSessionId) ?? 1) - 1,
        );
      }
    },
    peakGlobal: () => observedPeakGlobal,
    peakForSession: (piSessionId) => peakBySession.get(piSessionId) ?? 0,
    rehydratedValues: (piSessionId) => [...(restoredBySession.get(piSessionId) ?? [])],
    shutdownCount: () => observedShutdownCount,
  };
}

async function createFixture(maxConcurrentActivations = 2) {
  const root = await mkdtemp(join(tmpdir(), "agent-dock-embedded-test-"));
  const tracker = createActivityTracker();
  const options: EmbeddedPiBackendOptions = {
    cwd: join(root, "workspace"),
    agentDir: join(root, "agent-home"),
    sessionDir: join(root, "sessions"),
    maxConcurrentActivations,
    extensionFactories: [createPortableCounterExtension(tracker.observe)],
  };
  return {
    root,
    tracker,
    options,
    backend: new EmbeddedPiBackend(options),
  };
}

describe("EmbeddedPiBackend experiment", () => {
  it("rehydrates messages and appendEntry state in a fresh backend instance", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.backend.execute({
        logicalSessionId: "session-a",
        command: "/portable-counter",
      });
      const second = await fixture.backend.execute({
        logicalSessionId: "session-a",
        command: "/portable-counter",
      });

      expect(readPortableCounter(first.entries)).toBe(1);
      expect(first.restoredMessageCount).toBe(0);
      expect(first.finalMessageCount).toBe(1);
      expect(readPortableCounter(second.entries)).toBe(2);
      expect(second.restoredMessageCount).toBe(1);
      expect(second.restoredMessageRoles).toEqual(["assistant"]);
      expect(second.finalMessageCount).toBe(1);
      expect(second.piSessionId).toBe(first.piSessionId);
      expect(second.workerPid).toBe(first.workerPid);
      expect(second.activationId).toBeGreaterThan(first.activationId);

      // This object has no in-memory session/checkpoint cache from the first
      // backend. The durable session file is its only hand-off input.
      const replacement = new EmbeddedPiBackend(fixture.options);
      const third = await replacement.execute({
        logicalSessionId: "session-a",
        command: "/portable-counter",
        checkpoint: second.checkpoint,
      });

      expect(third.backendInstanceId).not.toBe(second.backendInstanceId);
      expect(third.piSessionId).toBe(first.piSessionId);
      expect(third.restoredMessageCount).toBe(1);
      expect(third.restoredMessageRoles).toEqual(["assistant"]);
      expect(third.finalMessageCount).toBe(1);
      expect(readPortableCounter(third.entries)).toBe(3);
      expect(fixture.tracker.rehydratedValues(first.piSessionId)).toEqual([0, 1, 2]);
      expect(fixture.tracker.shutdownCount()).toBe(3);
      expect(fixture.backend.metrics).toMatchObject({
        activeActivations: 0,
        sessionLaneCount: 0,
      });
      expect(replacement.metrics).toMatchObject({
        activeActivations: 0,
        sessionLaneCount: 0,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes one session while allowing bounded cross-session concurrency", async () => {
    const fixture = await createFixture(2);
    try {
      const firstA = await fixture.backend.execute({
        logicalSessionId: "session-a",
        command: "/portable-counter",
      });
      const firstB = await fixture.backend.execute({
        logicalSessionId: "session-b",
        command: "/portable-counter",
      });

      const [secondA, secondB] = await Promise.all([
        fixture.backend.execute({
          logicalSessionId: "session-a",
          command: "/portable-counter 80",
        }),
        fixture.backend.execute({
          logicalSessionId: "session-b",
          command: "/portable-counter 80",
        }),
      ]);
      expect(readPortableCounter(secondA.entries)).toBe(2);
      expect(readPortableCounter(secondB.entries)).toBe(2);
      expect(fixture.tracker.peakGlobal()).toBe(2);
      expect(fixture.backend.metrics.peakActiveActivations).toBe(2);

      const [thirdA, fourthA] = await Promise.all([
        fixture.backend.execute({
          logicalSessionId: "session-a",
          command: "/portable-counter 40",
        }),
        fixture.backend.execute({
          logicalSessionId: "session-a",
          command: "/portable-counter",
        }),
      ]);
      expect([readPortableCounter(thirdA.entries), readPortableCounter(fourthA.entries)]).toEqual([
        3, 4,
      ]);
      expect(thirdA.activationId).toBeLessThan(fourthA.activationId);
      expect(fixture.tracker.peakForSession(firstA.piSessionId)).toBe(1);
      expect(fixture.tracker.peakForSession(firstB.piSessionId)).toBe(1);
      expect(fixture.backend.metrics).toMatchObject({
        activeActivations: 0,
        waitingForCapacity: 0,
        sessionLaneCount: 0,
        knownSessionCount: 2,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects foreign checkpoints and releases capacity after extension failure", async () => {
    const fixture = await createFixture(1);
    try {
      const foreignSession = join(fixture.root, "foreign-session.jsonl");
      await writeFile(foreignSession, "{}\n", "utf8");
      await expect(
        fixture.backend.execute({
          logicalSessionId: "foreign",
          command: "/portable-counter",
          checkpoint: { sessionFile: foreignSession },
        }),
      ).rejects.toThrow("outside the backend-owned session directory");

      await expect(
        fixture.backend.execute({
          logicalSessionId: "session-a",
          command: "/portable-counter not-a-number",
        }),
      ).rejects.toThrow("delay must be an integer");
      expect(fixture.backend.metrics.activeActivations).toBe(0);

      const recovered = await fixture.backend.execute({
        logicalSessionId: "session-a",
        command: "/portable-counter",
      });
      expect(readPortableCounter(recovered.entries)).toBe(1);
      expect(fixture.backend.metrics).toMatchObject({
        activeActivations: 0,
        waitingForCapacity: 0,
        sessionLaneCount: 0,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
