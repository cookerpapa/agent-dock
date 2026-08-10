import { MAX_PI_SESSION_SNAPSHOT_BYTES } from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";

export const PI_SESSION_MANIFEST_FORMAT = "agent-dock.pi-session-manifest.v3";
export const PI_SESSION_MANIFEST_MEDIA_TYPE =
  "application/vnd.agent-dock.pi-session-manifest.v3+json";
export const PI_SESSION_LEGACY_MANIFEST_MEDIA_TYPE =
  "application/vnd.agent-dock.pi-session-manifest+json";
export const PI_SESSION_MANIFEST_MAX_BYTES = 2 * 1_024 * 1_024;
export const PI_SESSION_SEGMENT_TARGET_BYTES = 8 * 1_024 * 1_024;
export const PI_SESSION_MANIFEST_MAX_SEGMENTS = 64;

const LEGACY_MANIFEST_FORMAT = "agent-dock.pi-session-manifest.v2";
const LEGACY_MANIFEST_MAX_SEGMENTS = 32;
const RESTORE_CONCURRENCY = 4;

export type PiSessionSegmentDescriptor = {
  /** SHA-256 and size of the reconstructed native JSONL bytes. */
  sha256: string;
  sizeBytes: number;
  lineCount: number;
  encoding: "gzip" | "identity";
  /** SHA-256 and size of the immutable object-store representation. */
  storedSha256: string;
  storedSizeBytes: number;
};

export type PiSessionManifest = {
  format: typeof PI_SESSION_MANIFEST_FORMAT;
  piVersion: string;
  mode: "append" | "rebase";
  previousManifestSha256?: string;
  segments: PiSessionSegmentDescriptor[];
  sessionSha256: string;
  totalSizeBytes: number;
  totalLineCount: number;
};

export type PiSessionSegment = {
  descriptor: PiSessionSegmentDescriptor;
  /** Compressed bytes written to object storage. */
  bytes: Uint8Array;
};

export type PreparedPiSessionManifest = {
  manifest: PiSessionManifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  newSegments: PiSessionSegment[];
};

export type PreviousPiSessionManifest = {
  manifest: PiSessionManifest;
  manifestSha256: string;
};

export class PiSessionManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSessionManifestError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function lineCount(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}

function assertJsonlBoundary(bytes: Uint8Array, description: string): void {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_PI_SESSION_SNAPSHOT_BYTES ||
    bytes.at(-1) !== 0x0a ||
    lineCount(bytes) < 2
  ) {
    throw new PiSessionManifestError(`${description} is not bounded settled JSONL`);
  }
}

function encodeSegment(rawBytes: Uint8Array): PiSessionSegment {
  const storedBytes = gzipSync(rawBytes, { level: zlibConstants.Z_BEST_SPEED });
  return {
    descriptor: {
      sha256: digest(rawBytes),
      sizeBytes: rawBytes.byteLength,
      lineCount: lineCount(rawBytes),
      encoding: "gzip",
      storedSha256: digest(storedBytes),
      storedSizeBytes: storedBytes.byteLength,
    },
    bytes: storedBytes,
  };
}

/**
 * Fixed-size chunks keep every S3 operation bounded even when one JSONL entry
 * contains a very large Tool result. JSONL framing is validated after complete
 * reconstruction rather than requiring every physical chunk to end on a line.
 */
function segment(bytes: Uint8Array): PiSessionSegment[] {
  assertJsonlBoundary(bytes, "Pi session");
  const output: PiSessionSegment[] = [];
  for (let start = 0; start < bytes.byteLength; start += PI_SESSION_SEGMENT_TARGET_BYTES) {
    output.push(
      encodeSegment(
        bytes.subarray(start, Math.min(start + PI_SESSION_SEGMENT_TARGET_BYTES, bytes.byteLength)),
      ),
    );
  }
  return output;
}

function segmentSuffix(bytes: Uint8Array): PiSessionSegment[] {
  if (bytes.byteLength < 1 || bytes.at(-1) !== 0x0a) {
    throw new PiSessionManifestError("Pi session suffix is not line aligned");
  }
  const output: PiSessionSegment[] = [];
  for (let start = 0; start < bytes.byteLength; start += PI_SESSION_SEGMENT_TARGET_BYTES) {
    output.push(
      encodeSegment(
        bytes.subarray(start, Math.min(start + PI_SESSION_SEGMENT_TARGET_BYTES, bytes.byteLength)),
      ),
    );
  }
  return output;
}

function canonicalManifestBytes(manifest: PiSessionManifest): Uint8Array {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function makeManifest(
  piVersion: string,
  mode: PiSessionManifest["mode"],
  descriptors: PiSessionSegmentDescriptor[],
  sessionBytes: Uint8Array,
  previousManifestSha256?: string,
): PiSessionManifest {
  return {
    format: PI_SESSION_MANIFEST_FORMAT,
    piVersion,
    mode,
    ...(previousManifestSha256 === undefined ? {} : { previousManifestSha256 }),
    segments: descriptors,
    sessionSha256: digest(sessionBytes),
    totalSizeBytes: sessionBytes.byteLength,
    totalLineCount: lineCount(sessionBytes),
  };
}

export function preparePiSessionManifest(
  sessionBytes: Uint8Array,
  piVersion: string,
  previous?: PreviousPiSessionManifest,
): PreparedPiSessionManifest {
  assertJsonlBoundary(sessionBytes, "Pi session");
  if (piVersion.length < 1 || piVersion.length > 64 || piVersion.includes("\0")) {
    throw new PiSessionManifestError("Pi version is invalid");
  }

  let mode: PiSessionManifest["mode"] = "rebase";
  let previousManifestSha256: string | undefined;
  let descriptors: PiSessionSegmentDescriptor[] = [];
  let newSegments: PiSessionSegment[] = [];

  if (
    previous !== undefined &&
    previous.manifest.totalSizeBytes < sessionBytes.byteLength &&
    digest(sessionBytes.subarray(0, previous.manifest.totalSizeBytes)) ===
      previous.manifest.sessionSha256
  ) {
    mode = "append";
    previousManifestSha256 = previous.manifestSha256;
    const previousDescriptors = previous.manifest.segments;
    const previousLast = previousDescriptors.at(-1)!;
    // A settled Run is usually much smaller than 8 MiB. Rewriting one bounded
    // partial tail prevents the active manifest from growing by one object per
    // Turn while still reusing every already-full immutable chunk.
    const reusableCount =
      previousLast.sizeBytes === PI_SESSION_SEGMENT_TARGET_BYTES
        ? previousDescriptors.length
        : previousDescriptors.length - 1;
    const reusable = previousDescriptors
      .slice(0, reusableCount)
      .map((descriptor) => ({ ...descriptor }));
    const reusableBytes = reusable.reduce((sum, descriptor) => sum + descriptor.sizeBytes, 0);
    const tailSegments = segmentSuffix(sessionBytes.subarray(reusableBytes));
    newSegments = tailSegments;
    descriptors = [...reusable, ...tailSegments.map((entry) => entry.descriptor)];
  }

  if (
    mode === "rebase" ||
    descriptors.length > PI_SESSION_MANIFEST_MAX_SEGMENTS ||
    descriptors.length === 0
  ) {
    mode = "rebase";
    previousManifestSha256 = previous?.manifestSha256;
    newSegments = segment(sessionBytes);
    descriptors = newSegments.map((entry) => entry.descriptor);
  }

  if (descriptors.length > PI_SESSION_MANIFEST_MAX_SEGMENTS) {
    throw new PiSessionManifestError("Pi session requires too many bounded segments");
  }
  const manifest = makeManifest(piVersion, mode, descriptors, sessionBytes, previousManifestSha256);
  const manifestBytes = canonicalManifestBytes(manifest);
  if (manifestBytes.byteLength > PI_SESSION_MANIFEST_MAX_BYTES) {
    throw new PiSessionManifestError("Pi session manifest is outside its byte limit");
  }
  return {
    manifest,
    manifestBytes,
    manifestSha256: digest(manifestBytes),
    newSegments,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiSessionManifestError("Pi session manifest is not an object");
  }
  return value as Record<string, unknown>;
}

function commonManifestMetadata(value: Record<string, unknown>, maximumSegments: number): void {
  if (
    typeof value.piVersion !== "string" ||
    value.piVersion.length < 1 ||
    value.piVersion.length > 64 ||
    (value.mode !== "append" && value.mode !== "rebase") ||
    !validSha256(value.sessionSha256) ||
    !Number.isSafeInteger(value.totalSizeBytes) ||
    Number(value.totalSizeBytes) < 1 ||
    Number(value.totalSizeBytes) > MAX_PI_SESSION_SNAPSHOT_BYTES ||
    !Number.isSafeInteger(value.totalLineCount) ||
    Number(value.totalLineCount) < 2 ||
    (value.previousManifestSha256 !== undefined && !validSha256(value.previousManifestSha256)) ||
    !Array.isArray(value.segments) ||
    value.segments.length < 1 ||
    value.segments.length > maximumSegments
  ) {
    throw new PiSessionManifestError("Pi session manifest metadata is invalid");
  }
}

function decodeLegacyDescriptor(raw: unknown): PiSessionSegmentDescriptor {
  const item = record(raw);
  if (
    !validSha256(item.sha256) ||
    !Number.isSafeInteger(item.sizeBytes) ||
    Number(item.sizeBytes) < 1 ||
    Number(item.sizeBytes) > MAX_PI_SESSION_SNAPSHOT_BYTES ||
    !Number.isSafeInteger(item.lineCount) ||
    Number(item.lineCount) < 0
  ) {
    throw new PiSessionManifestError("Pi session segment metadata is invalid");
  }
  return {
    sha256: item.sha256,
    sizeBytes: Number(item.sizeBytes),
    lineCount: Number(item.lineCount),
    encoding: "identity",
    storedSha256: item.sha256,
    storedSizeBytes: Number(item.sizeBytes),
  };
}

function decodeDescriptor(raw: unknown): PiSessionSegmentDescriptor {
  const item = record(raw);
  if (
    !validSha256(item.sha256) ||
    !Number.isSafeInteger(item.sizeBytes) ||
    Number(item.sizeBytes) < 1 ||
    Number(item.sizeBytes) > PI_SESSION_SEGMENT_TARGET_BYTES ||
    !Number.isSafeInteger(item.lineCount) ||
    Number(item.lineCount) < 0 ||
    item.encoding !== "gzip" ||
    !validSha256(item.storedSha256) ||
    !Number.isSafeInteger(item.storedSizeBytes) ||
    Number(item.storedSizeBytes) < 1 ||
    Number(item.storedSizeBytes) > PI_SESSION_SEGMENT_TARGET_BYTES + 1_024 * 1_024
  ) {
    throw new PiSessionManifestError("Pi session segment metadata is invalid");
  }
  return {
    sha256: item.sha256,
    sizeBytes: Number(item.sizeBytes),
    lineCount: Number(item.lineCount),
    encoding: "gzip",
    storedSha256: item.storedSha256,
    storedSizeBytes: Number(item.storedSizeBytes),
  };
}

/**
 * V2 remains a read-only migration format so an in-place deployment can write
 * its next V3 manifest without discarding existing immutable checkpoints.
 */
export function decodePiSessionManifest(bytes: Uint8Array): PiSessionManifest {
  if (bytes.byteLength < 1 || bytes.byteLength > PI_SESSION_MANIFEST_MAX_BYTES) {
    throw new PiSessionManifestError("Pi session manifest is outside its byte limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PiSessionManifestError("Pi session manifest is not valid UTF-8");
  }
  if (!text.endsWith("\n") || text.includes("\0")) {
    throw new PiSessionManifestError("Pi session manifest framing is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PiSessionManifestError("Pi session manifest is malformed JSON");
  }
  const value = record(parsed);
  const legacy = value.format === LEGACY_MANIFEST_FORMAT;
  if (!legacy && value.format !== PI_SESSION_MANIFEST_FORMAT) {
    throw new PiSessionManifestError("Pi session manifest format is unsupported");
  }
  commonManifestMetadata(
    value,
    legacy ? LEGACY_MANIFEST_MAX_SEGMENTS : PI_SESSION_MANIFEST_MAX_SEGMENTS,
  );
  const segments = (value.segments as unknown[]).map((raw) =>
    legacy ? decodeLegacyDescriptor(raw) : decodeDescriptor(raw),
  );
  if (
    segments.reduce((sum, item) => sum + item.sizeBytes, 0) !== value.totalSizeBytes ||
    segments.reduce((sum, item) => sum + item.lineCount, 0) !== value.totalLineCount
  ) {
    throw new PiSessionManifestError("Pi session manifest totals are inconsistent");
  }
  return {
    format: PI_SESSION_MANIFEST_FORMAT,
    piVersion: value.piVersion as string,
    mode: value.mode as PiSessionManifest["mode"],
    ...(value.previousManifestSha256 === undefined
      ? {}
      : { previousManifestSha256: value.previousManifestSha256 as string }),
    segments,
    sessionSha256: value.sessionSha256 as string,
    totalSizeBytes: Number(value.totalSizeBytes),
    totalLineCount: Number(value.totalLineCount),
  };
}

function decodeStoredSegment(
  descriptor: PiSessionSegmentDescriptor,
  storedBytes: Uint8Array,
): Uint8Array {
  if (
    storedBytes.byteLength !== descriptor.storedSizeBytes ||
    digest(storedBytes) !== descriptor.storedSha256
  ) {
    throw new PiSessionManifestError("Pi session segment failed stored integrity validation");
  }
  let rawBytes: Uint8Array;
  try {
    rawBytes = descriptor.encoding === "gzip" ? gunzipSync(storedBytes) : storedBytes;
  } catch {
    throw new PiSessionManifestError("Pi session segment decompression failed");
  }
  if (
    rawBytes.byteLength !== descriptor.sizeBytes ||
    lineCount(rawBytes) !== descriptor.lineCount ||
    digest(rawBytes) !== descriptor.sha256
  ) {
    throw new PiSessionManifestError("Pi session segment failed integrity validation");
  }
  return rawBytes;
}

export async function restorePiSessionManifest(
  manifest: PiSessionManifest,
  loadSegment: (descriptor: PiSessionSegmentDescriptor) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const restored = Buffer.allocUnsafe(manifest.totalSizeBytes);
  let writeOffset = 0;
  for (let start = 0; start < manifest.segments.length; start += RESTORE_CONCURRENCY) {
    const descriptors = manifest.segments.slice(start, start + RESTORE_CONCURRENCY);
    const batch = await Promise.all(
      descriptors.map(async (descriptor) =>
        decodeStoredSegment(descriptor, await loadSegment(descriptor)),
      ),
    );
    for (const rawBytes of batch) {
      Buffer.from(rawBytes).copy(restored, writeOffset);
      writeOffset += rawBytes.byteLength;
    }
  }
  if (
    writeOffset !== manifest.totalSizeBytes ||
    lineCount(restored) !== manifest.totalLineCount ||
    digest(restored) !== manifest.sessionSha256
  ) {
    throw new PiSessionManifestError("Reconstructed Pi session failed integrity validation");
  }
  assertJsonlBoundary(restored, "Reconstructed Pi session");
  return restored;
}
