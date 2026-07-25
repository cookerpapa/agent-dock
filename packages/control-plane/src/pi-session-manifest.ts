import { MAX_PI_SESSION_SNAPSHOT_BYTES } from "@agent-dock/protocol";
import { createHash } from "node:crypto";

export const PI_SESSION_MANIFEST_FORMAT = "agent-dock.pi-session-manifest.v2";
export const PI_SESSION_MANIFEST_MEDIA_TYPE = "application/vnd.agent-dock.pi-session-manifest+json";
export const PI_SESSION_SEGMENT_TARGET_BYTES = 256 * 1_024;
export const PI_SESSION_MANIFEST_MAX_SEGMENTS = 32;

export type PiSessionSegmentDescriptor = {
  sha256: string;
  sizeBytes: number;
  lineCount: number;
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
  bytes: Uint8Array;
};

export type PreparedPiSessionManifest = {
  manifest: PiSessionManifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  newSegments: PiSessionSegment[];
};

export type PreviousPiSessionManifest = {
  bytes: Uint8Array;
  manifest?: PiSessionManifest;
  manifestSha256?: string;
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

function segment(bytes: Uint8Array): PiSessionSegment[] {
  assertJsonlBoundary(bytes, "Pi session");
  const output: PiSessionSegment[] = [];
  let segmentStart = 0;
  let lineStart = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const lineEnd = index + 1;
    if (lineStart > segmentStart && lineEnd - segmentStart > PI_SESSION_SEGMENT_TARGET_BYTES) {
      const part = bytes.slice(segmentStart, lineStart);
      output.push({
        descriptor: {
          sha256: digest(part),
          sizeBytes: part.byteLength,
          lineCount: lineCount(part),
        },
        bytes: part,
      });
      segmentStart = lineStart;
    }
    lineStart = lineEnd;
  }
  if (segmentStart < bytes.byteLength) {
    const part = bytes.slice(segmentStart);
    output.push({
      descriptor: {
        sha256: digest(part),
        sizeBytes: part.byteLength,
        lineCount: lineCount(part),
      },
      bytes: part,
    });
  }
  return output;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
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
    previous.bytes.byteLength < sessionBytes.byteLength &&
    previous.bytes.at(-1) === 0x0a &&
    startsWith(sessionBytes, previous.bytes)
  ) {
    mode = "append";
    previousManifestSha256 = previous.manifestSha256;
    const v1BaseSegments = previous.manifest === undefined ? segment(previous.bytes) : [];
    const baseSegments =
      previous.manifest === undefined
        ? v1BaseSegments.map((entry) => entry.descriptor)
        : previous.manifest.segments.map((descriptor) => ({ ...descriptor }));
    const suffix = sessionBytes.slice(previous.bytes.byteLength);
    const suffixSegments = segmentSuffix(suffix);
    newSegments = [...v1BaseSegments, ...suffixSegments];
    descriptors = [...baseSegments, ...suffixSegments.map((entry) => entry.descriptor)];
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

  const manifest = makeManifest(piVersion, mode, descriptors, sessionBytes, previousManifestSha256);
  const manifestBytes = canonicalManifestBytes(manifest);
  return {
    manifest,
    manifestBytes,
    manifestSha256: digest(manifestBytes),
    newSegments,
  };
}

function segmentSuffix(bytes: Uint8Array): PiSessionSegment[] {
  if (bytes.byteLength < 1 || bytes.at(-1) !== 0x0a) {
    throw new PiSessionManifestError("Pi session suffix is not line aligned");
  }
  const output: PiSessionSegment[] = [];
  let segmentStart = 0;
  let lineStart = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const lineEnd = index + 1;
    if (lineStart > segmentStart && lineEnd - segmentStart > PI_SESSION_SEGMENT_TARGET_BYTES) {
      const part = bytes.slice(segmentStart, lineStart);
      output.push({
        descriptor: {
          sha256: digest(part),
          sizeBytes: part.byteLength,
          lineCount: lineCount(part),
        },
        bytes: part,
      });
      segmentStart = lineStart;
    }
    lineStart = lineEnd;
  }
  const part = bytes.slice(segmentStart);
  output.push({
    descriptor: {
      sha256: digest(part),
      sizeBytes: part.byteLength,
      lineCount: lineCount(part),
    },
    bytes: part,
  });
  return output;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiSessionManifestError("Pi session manifest is not an object");
  }
  return value as Record<string, unknown>;
}

export function decodePiSessionManifest(bytes: Uint8Array): PiSessionManifest {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PI_SESSION_SNAPSHOT_BYTES) {
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
  if (
    value.format !== PI_SESSION_MANIFEST_FORMAT ||
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
    value.segments.length > PI_SESSION_MANIFEST_MAX_SEGMENTS
  ) {
    throw new PiSessionManifestError("Pi session manifest metadata is invalid");
  }
  const segments = value.segments.map((raw) => {
    const item = record(raw);
    if (
      !validSha256(item.sha256) ||
      !Number.isSafeInteger(item.sizeBytes) ||
      Number(item.sizeBytes) < 1 ||
      Number(item.sizeBytes) > MAX_PI_SESSION_SNAPSHOT_BYTES ||
      !Number.isSafeInteger(item.lineCount) ||
      Number(item.lineCount) < 1
    ) {
      throw new PiSessionManifestError("Pi session segment metadata is invalid");
    }
    return {
      sha256: item.sha256,
      sizeBytes: Number(item.sizeBytes),
      lineCount: Number(item.lineCount),
    };
  });
  if (
    segments.reduce((sum, item) => sum + item.sizeBytes, 0) !== value.totalSizeBytes ||
    segments.reduce((sum, item) => sum + item.lineCount, 0) !== value.totalLineCount
  ) {
    throw new PiSessionManifestError("Pi session manifest totals are inconsistent");
  }
  return {
    format: PI_SESSION_MANIFEST_FORMAT,
    piVersion: value.piVersion,
    mode: value.mode,
    ...(value.previousManifestSha256 === undefined
      ? {}
      : { previousManifestSha256: value.previousManifestSha256 }),
    segments,
    sessionSha256: value.sessionSha256,
    totalSizeBytes: Number(value.totalSizeBytes),
    totalLineCount: Number(value.totalLineCount),
  };
}

export async function restorePiSessionManifest(
  manifest: PiSessionManifest,
  loadSegment: (descriptor: PiSessionSegmentDescriptor) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const loaded = await Promise.all(
    manifest.segments.map(async (descriptor) => {
      const bytes = await loadSegment(descriptor);
      if (
        bytes.byteLength !== descriptor.sizeBytes ||
        bytes.at(-1) !== 0x0a ||
        lineCount(bytes) !== descriptor.lineCount ||
        digest(bytes) !== descriptor.sha256
      ) {
        throw new PiSessionManifestError("Pi session segment failed integrity validation");
      }
      return bytes;
    }),
  );
  const restored = Buffer.concat(loaded.map((bytes) => Buffer.from(bytes)));
  if (
    restored.byteLength !== manifest.totalSizeBytes ||
    lineCount(restored) !== manifest.totalLineCount ||
    digest(restored) !== manifest.sessionSha256
  ) {
    throw new PiSessionManifestError("Reconstructed Pi session failed integrity validation");
  }
  assertJsonlBoundary(restored, "Reconstructed Pi session");
  return restored;
}
