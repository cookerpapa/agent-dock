import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  PI_SESSION_MANIFEST_MAX_SEGMENTS,
  preparePiSessionManifest,
  restorePiSessionManifest,
} from "../packages/control-plane/src/pi-session-manifest.ts";

const TURN_COUNT = 120;
const RESTORE_SAMPLES = 100;
const PI_VERSION = "0.80.10";
const encoder = new TextEncoder();

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function percentile(values, quantile) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(values.length * quantile) - 1));
  return Number(ordered[index].toFixed(3));
}

let jsonl = line({
  type: "session",
  version: 3,
  id: "11111111-1111-4111-8111-111111111111",
  timestamp: "2026-07-25T00:00:00.000Z",
  cwd: "/workspace",
});
const objects = new Map();
let previous;
let wholeFileStoredBytes = 0;
let manifestStoredBytes = 0;
let segmentStoredBytes = 0;
let finalPrepared;
let consolidationCount = 0;

for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
  const payload = `${String(turn).padStart(3, "0")}-${"x".repeat(2_048)}`;
  jsonl += line({
    type: "message",
    id: `u${String(turn).padStart(7, "0")}`,
    parentId: turn === 1 ? null : `a${String(turn - 1).padStart(7, "0")}`,
    timestamp: `2026-07-25T00:${String(Math.floor(turn / 60)).padStart(2, "0")}:${String(turn % 60).padStart(2, "0")}.000Z`,
    message: { role: "user", content: `turn-${payload}` },
  });
  jsonl += line({
    type: "message",
    id: `a${String(turn).padStart(7, "0")}`,
    parentId: `u${String(turn).padStart(7, "0")}`,
    timestamp: `2026-07-25T00:${String(Math.floor(turn / 60)).padStart(2, "0")}:${String(turn % 60).padStart(2, "0")}.500Z`,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `reply-${payload}` }],
      api: "benchmark",
      provider: "benchmark",
      model: "benchmark",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });

  const sessionBytes = encoder.encode(jsonl);
  wholeFileStoredBytes += sessionBytes.byteLength;
  const prepared = preparePiSessionManifest(sessionBytes, PI_VERSION, previous);
  if (prepared.manifest.mode === "rebase" && turn > 1) consolidationCount += 1;
  for (const segment of prepared.newSegments) {
    if (!objects.has(segment.descriptor.sha256)) {
      objects.set(segment.descriptor.sha256, segment.bytes);
      segmentStoredBytes += segment.bytes.byteLength;
    }
  }
  objects.set(prepared.manifestSha256, prepared.manifestBytes);
  manifestStoredBytes += prepared.manifestBytes.byteLength;
  previous = {
    bytes: sessionBytes,
    manifest: prepared.manifest,
    manifestSha256: prepared.manifestSha256,
  };
  finalPrepared = prepared;
}

assert(finalPrepared);
assert(finalPrepared.manifest.segments.length <= PI_SESSION_MANIFEST_MAX_SEGMENTS);
const expected = encoder.encode(jsonl);
const restoreDurations = [];
let restored;
for (let sample = 0; sample < RESTORE_SAMPLES; sample += 1) {
  const startedAt = performance.now();
  restored = await restorePiSessionManifest(finalPrepared.manifest, async (descriptor) => {
    const bytes = objects.get(descriptor.sha256);
    if (!bytes) throw new Error(`Missing benchmark segment ${descriptor.sha256}`);
    return bytes;
  });
  restoreDurations.push(performance.now() - startedAt);
}
assert.deepEqual(Buffer.from(restored), Buffer.from(expected));

const segmentedStoredBytes = segmentStoredBytes + manifestStoredBytes;
process.stdout.write(
  `${JSON.stringify(
    {
      result: "passed",
      piVersion: PI_VERSION,
      turns: TURN_COUNT,
      finalSessionBytes: expected.byteLength,
      fullSnapshotV1: {
        storedBytesAcrossTurns: wholeFileStoredBytes,
        objectsWritten: TURN_COUNT,
      },
      segmentedManifestV2: {
        storedBytesAcrossTurns: segmentedStoredBytes,
        uniqueSegmentBytes: segmentStoredBytes,
        manifestBytesAcrossTurns: manifestStoredBytes,
        uniqueObjects: objects.size,
        finalSegmentCount: finalPrepared.manifest.segments.length,
        periodicConsolidations: consolidationCount,
      },
      storageReductionPercent: Number(
        ((1 - segmentedStoredBytes / wholeFileStoredBytes) * 100).toFixed(2),
      ),
      finalRestore: {
        samples: RESTORE_SAMPLES,
        objectReads: finalPrepared.manifest.segments.length + 1,
        p50Ms: percentile(restoreDurations, 0.5),
        p95Ms: percentile(restoreDurations, 0.95),
        byteIdentical: true,
      },
      modelCalls: 0,
    },
    null,
    2,
  )}\n`,
);
