import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  EventSpoolError,
  type InMemoryEventSpoolOptions,
  type SupervisorEventSpoolRecoveryResult,
} from "./in-memory-event-spool.ts";

export const MAX_WAL_EVENT_SPOOL_MESSAGE_BYTES = 2 * 1_024 * 1_024;
export const DEFAULT_WAL_EVENT_SPOOL_BYTES = 64 * 1_024 * 1_024;
export const MAX_WAL_EVENT_SPOOL_FILES = 10_000;

export const MAX_PENDING_EVENTS_HARD_LIMIT = 100_000;
export const MAX_PENDING_BYTES_HARD_LIMIT = 1_024 * 1_024 * 1_024;
const MAX_WAL_OVERHEAD_BYTES = 256 * 1_024 * 1_024;
export const WAL_FILE_PATTERN = /^([0-9a-f]{64})\.wal$/;
export const TEMPORARY_FILE_PATTERN = /^\.tmp-[0-9a-f-]{36}$/;

export type AssignmentRecord = {
  kind: "assignment";
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  acknowledgedThroughSeq: number;
  maxPendingEvents: number;
  maxPendingBytes: number;
};

export type EventRecord = {
  kind: "event";
  sequence: number;
  message: EventPublishMessage;
};

export type AckRecord = {
  kind: "ack";
  acknowledgedThroughSeq: number;
};

export type RejectionRecord = {
  kind: "rejection";
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  rejectedSeq: number;
  code: "stale_fence";
  rejectedAt: string;
};

export type WalRecord = AssignmentRecord | EventRecord | AckRecord | RejectionRecord;

export type WalEnvelope = {
  format: "pi-cloud.event-spool-wal.v1";
  sha256: string;
  record: WalRecord;
};

export type PendingEvent = {
  message: EventPublishMessage;
  sizeBytes: number;
};

export type LoadedWal = {
  assignment: AssignmentRecord;
  pending: Map<number, PendingEvent>;
  pendingBytes: number;
  highestProducedSeq: number;
  walBytes: number;
  rejected: boolean;
};

export type WalEventSpoolOpenOptions = InMemoryEventSpoolOptions & {
  maxPendingBytes?: number;
};

export type WalEventSpoolStoreOptions = {
  rootDirectory: string;
  quarantineDirectory?: string;
  maxSpoolFiles?: number;
  clock?: () => Date;
};

export type WalEventSpoolReplayResult = SupervisorEventSpoolRecoveryResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validIdentity(value: unknown, description: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new EventSpoolError(`${description} is invalid`);
  }
  return value;
}

export function nonNegativeSafeInteger(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EventSpoolError(`${description} must be a non-negative safe integer`);
  }
  return value;
}

export function positiveSafeInteger(value: unknown, maximum: number, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new EventSpoolError(`${description} is outside its supported range`);
  }
  return value;
}

export function assignmentName(sessionId: string, leaseId: string, fencingToken: number): string {
  return sha256(
    `pi-cloud.event-spool-assignment.v1\0${sessionId}\0${leaseId}\0${String(fencingToken)}`,
  );
}

export function recordBytes(record: WalRecord): Buffer {
  const recordJson = JSON.stringify(record);
  if (
    record.kind === "event" &&
    Buffer.byteLength(JSON.stringify(record.message), "utf8") > MAX_WAL_EVENT_SPOOL_MESSAGE_BYTES
  ) {
    throw new EventSpoolError("Event publication exceeds the durable spool message limit");
  }
  const envelope: WalEnvelope = {
    format: "pi-cloud.event-spool-wal.v1",
    sha256: sha256(recordJson),
    record,
  };
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

export function parsePublish(value: unknown): EventPublishMessage {
  try {
    const parsed = parseSupervisorToControlMessage(value);
    if (parsed.type !== "event.publish") {
      throw new EventSpoolError(`Expected event.publish, received ${parsed.type}`);
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof EventSpoolError) throw error;
    throw new EventSpoolError("Event publication failed wire validation");
  }
}

export function parseAck(value: unknown): EventAckMessage {
  try {
    const parsed = parseControlToSupervisorMessage(value);
    if (parsed.type !== "event.ack") {
      throw new EventSpoolError(`Expected event.ack, received ${parsed.type}`);
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof EventSpoolError) throw error;
    throw new EventSpoolError("Event ACK failed wire validation");
  }
}

function parseWalRecord(line: string): WalRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new EventSpoolError("Durable event WAL contains invalid JSON");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["format", "sha256", "record"]) ||
    value.format !== "pi-cloud.event-spool-wal.v1" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !isRecord(value.record)
  ) {
    throw new EventSpoolError("Durable event WAL record shape is invalid");
  }
  const recordJson = JSON.stringify(value.record);
  if (value.sha256 !== sha256(recordJson)) {
    throw new EventSpoolError("Durable event WAL record failed integrity validation");
  }
  const kind = value.record.kind;
  if (kind === "assignment") {
    if (
      !hasExactKeys(value.record, [
        "kind",
        "sessionId",
        "leaseId",
        "fencingToken",
        "acknowledgedThroughSeq",
        "maxPendingEvents",
        "maxPendingBytes",
      ])
    ) {
      throw new EventSpoolError("Durable event WAL assignment shape is invalid");
    }
    return {
      kind,
      sessionId: validIdentity(value.record.sessionId, "WAL session ID"),
      leaseId: validIdentity(value.record.leaseId, "WAL lease ID"),
      fencingToken: positiveSafeInteger(
        value.record.fencingToken,
        Number.MAX_SAFE_INTEGER,
        "WAL fencing token",
      ),
      acknowledgedThroughSeq: nonNegativeSafeInteger(
        value.record.acknowledgedThroughSeq,
        "WAL ACK cursor",
      ),
      maxPendingEvents: positiveSafeInteger(
        value.record.maxPendingEvents,
        MAX_PENDING_EVENTS_HARD_LIMIT,
        "WAL event capacity",
      ),
      maxPendingBytes: positiveSafeInteger(
        value.record.maxPendingBytes,
        MAX_PENDING_BYTES_HARD_LIMIT,
        "WAL byte capacity",
      ),
    };
  }
  if (kind === "event") {
    if (!hasExactKeys(value.record, ["kind", "sequence", "message"])) {
      throw new EventSpoolError("Durable event WAL event shape is invalid");
    }
    const message = parsePublish(value.record.message);
    const sequence = positiveSafeInteger(
      value.record.sequence,
      Number.MAX_SAFE_INTEGER,
      "WAL event sequence",
    );
    if (message.payload.event.seq !== sequence) {
      throw new EventSpoolError("Durable event WAL sequence does not match its event");
    }
    return { kind, sequence, message };
  }
  if (kind === "ack") {
    if (!hasExactKeys(value.record, ["kind", "acknowledgedThroughSeq"])) {
      throw new EventSpoolError("Durable event WAL ACK shape is invalid");
    }
    return {
      kind,
      acknowledgedThroughSeq: nonNegativeSafeInteger(
        value.record.acknowledgedThroughSeq,
        "WAL ACK cursor",
      ),
    };
  }
  if (kind === "rejection") {
    if (
      !hasExactKeys(value.record, [
        "kind",
        "sessionId",
        "leaseId",
        "fencingToken",
        "rejectedSeq",
        "code",
        "rejectedAt",
      ]) ||
      value.record.code !== "stale_fence" ||
      typeof value.record.rejectedAt !== "string" ||
      Number.isNaN(new Date(value.record.rejectedAt).valueOf())
    ) {
      throw new EventSpoolError("Durable event WAL rejection shape is invalid");
    }
    return {
      kind,
      sessionId: validIdentity(value.record.sessionId, "WAL rejection session ID"),
      leaseId: validIdentity(value.record.leaseId, "WAL rejection lease ID"),
      fencingToken: positiveSafeInteger(
        value.record.fencingToken,
        Number.MAX_SAFE_INTEGER,
        "WAL rejection fencing token",
      ),
      rejectedSeq: positiveSafeInteger(
        value.record.rejectedSeq,
        Number.MAX_SAFE_INTEGER,
        "WAL rejected sequence",
      ),
      code: value.record.code,
      rejectedAt: new Date(value.record.rejectedAt).toISOString(),
    };
  }
  throw new EventSpoolError("Durable event WAL contains an unsupported record");
}

export function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("event spool clock must return a valid Date");
  }
  return value;
}

export function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new EventSpoolError("Durable event spool directory is not a private regular directory");
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTemporaryFile(directory: string, bytes: Buffer): Promise<string> {
  const path = resolve(directory, `.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return path;
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function publishNoOverwrite(target: string, bytes: Buffer): Promise<boolean> {
  const directory = resolve(target, "..");
  const temporary = await writeTemporaryFile(directory, bytes);
  try {
    try {
      await link(temporary, target);
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
    await syncDirectory(directory);
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function replaceAtomically(target: string, bytes: Buffer): Promise<void> {
  const directory = resolve(target, "..");
  const temporary = await writeTemporaryFile(directory, bytes);
  try {
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function appendDurably(path: string, bytes: Buffer): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new EventSpoolError("Durable event WAL is not a private regular file");
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error: unknown) {
    if (error instanceof EventSpoolError) throw error;
    throw new EventSpoolError("Durable event WAL append failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function truncatePartialTail(path: string, size: number): Promise<number> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return size;
    let cursor = size;
    const chunk = Buffer.alloc(64 * 1_024);
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunk.byteLength);
      const length = cursor - start;
      await handle.read(chunk, 0, length, start);
      const newline = chunk.subarray(0, length).lastIndexOf(0x0a);
      if (newline >= 0) {
        const truncated = start + newline + 1;
        await handle.truncate(truncated);
        await handle.sync();
        return truncated;
      }
      cursor = start;
    }
    throw new EventSpoolError("Durable event WAL has no complete assignment record");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function loadWal(path: string): Promise<LoadedWal> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > MAX_PENDING_BYTES_HARD_LIMIT + MAX_WAL_OVERHEAD_BYTES
    ) {
      throw new EventSpoolError("Durable event WAL is outside its byte limit");
    }
    await handle.close();
    handle = undefined;
    const completeSize = await truncatePartialTail(path, metadata.size);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    bytes = await handle.readFile();
    if (bytes.byteLength !== completeSize) {
      throw new EventSpoolError("Durable event WAL changed while it was loading");
    }
  } catch (error: unknown) {
    if (error instanceof EventSpoolError) throw error;
    throw new EventSpoolError("Durable event WAL could not be read safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const lines = bytes.toString("utf8").split("\n");
  lines.pop();
  if (lines.length === 0) throw new EventSpoolError("Durable event WAL is empty");
  const first = parseWalRecord(lines[0]!);
  if (first.kind !== "assignment") {
    throw new EventSpoolError("Durable event WAL does not begin with an assignment");
  }
  const pending = new Map<number, PendingEvent>();
  let pendingBytes = 0;
  let highestProducedSeq = first.acknowledgedThroughSeq;
  let acknowledgedThroughSeq = first.acknowledgedThroughSeq;
  let rejected = false;
  for (const line of lines.slice(1)) {
    if (Buffer.byteLength(line, "utf8") > MAX_WAL_EVENT_SPOOL_MESSAGE_BYTES + 4_096) {
      throw new EventSpoolError("Durable event WAL record exceeds its byte limit");
    }
    if (rejected) throw new EventSpoolError("Durable event WAL continues after rejection");
    const record = parseWalRecord(line);
    if (record.kind === "assignment") {
      throw new EventSpoolError("Durable event WAL contains a second assignment");
    }
    if (record.kind === "event") {
      assertPublishAssignment(first, record.message);
      if (record.sequence !== highestProducedSeq + 1) {
        throw new EventSpoolError(
          `Durable event WAL expected sequence ${String(highestProducedSeq + 1)}, found ${String(record.sequence)}`,
        );
      }
      const sizeBytes = recordBytes(record).byteLength;
      pending.set(record.sequence, { message: record.message, sizeBytes });
      pendingBytes += sizeBytes;
      highestProducedSeq = record.sequence;
      continue;
    }
    if (record.kind === "ack") {
      if (
        record.acknowledgedThroughSeq < acknowledgedThroughSeq ||
        record.acknowledgedThroughSeq > highestProducedSeq
      ) {
        throw new EventSpoolError("Durable event WAL contains an invalid cumulative ACK");
      }
      for (
        let sequence = acknowledgedThroughSeq + 1;
        sequence <= record.acknowledgedThroughSeq;
        sequence += 1
      ) {
        const event = pending.get(sequence);
        if (event === undefined) {
          throw new EventSpoolError("Durable event WAL ACK crosses a sequence gap");
        }
        pending.delete(sequence);
        pendingBytes -= event.sizeBytes;
      }
      acknowledgedThroughSeq = record.acknowledgedThroughSeq;
      continue;
    }
    if (
      record.sessionId !== first.sessionId ||
      record.leaseId !== first.leaseId ||
      record.fencingToken !== first.fencingToken ||
      record.rejectedSeq <= acknowledgedThroughSeq ||
      record.rejectedSeq > highestProducedSeq
    ) {
      throw new EventSpoolError("Durable event WAL rejection does not match its assignment");
    }
    rejected = true;
  }
  if (pending.size > first.maxPendingEvents || pendingBytes > first.maxPendingBytes) {
    throw new EventSpoolError("Durable event WAL exceeds its configured capacity");
  }
  return {
    assignment: { ...first, acknowledgedThroughSeq },
    pending,
    pendingBytes,
    highestProducedSeq,
    walBytes: bytes.byteLength,
    rejected,
  };
}

export function assertPublishAssignment(
  assignment: AssignmentRecord,
  message: EventPublishMessage,
): void {
  if (
    message.payload.event.sessionId !== assignment.sessionId ||
    message.payload.leaseId !== assignment.leaseId ||
    message.payload.fencingToken !== assignment.fencingToken
  ) {
    throw new EventSpoolError("Event spool message belongs to a stale assignment");
  }
}
