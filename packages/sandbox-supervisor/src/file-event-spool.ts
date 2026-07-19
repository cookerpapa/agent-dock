import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
} from "@agent-dock/protocol";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  EventSpoolError,
  type EventSpoolAckResult,
  type EventSpoolAppendResult,
  type InMemoryEventSpoolOptions,
  type SupervisorEventSpool,
  type SupervisorEventSpoolRecovery,
  type SupervisorEventSpoolRecoveryResult,
} from "./in-memory-event-spool.ts";

export const MAX_FILE_EVENT_SPOOL_MESSAGE_BYTES = 2 * 1_024 * 1_024;
export const DEFAULT_FILE_EVENT_SPOOL_BYTES = 64 * 1_024 * 1_024;
export const MAX_FILE_EVENT_SPOOL_DIRECTORIES = 10_000;

const MANIFEST_FILE = "manifest.json";
const EVENTS_DIRECTORY = "events";
const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_EVENT_FILE_BYTES = MAX_FILE_EVENT_SPOOL_MESSAGE_BYTES + 1_024;
const MAX_PENDING_EVENTS_HARD_LIMIT = 100_000;
const MAX_PENDING_BYTES_HARD_LIMIT = 1_024 * 1_024 * 1_024;
const SPOOL_DIRECTORY_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_FILE_PATTERN = /^([1-9][0-9]*)\.json$/;
const TEMPORARY_FILE_PATTERN = /^\.tmp-[0-9a-f-]{36}$/;

type EventSpoolManifestState = {
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  acknowledgedThroughSeq: number;
  maxPendingEvents: number;
  maxPendingBytes: number;
};

type EventSpoolManifestEnvelope = {
  format: "agent-dock.event-spool-manifest.v1";
  sha256: string;
  state: EventSpoolManifestState;
};

type EventSpoolFileEnvelope = {
  format: "agent-dock.event-spool-event.v1";
  sha256: string;
  message: EventPublishMessage;
};

type PendingEvent = {
  message: EventPublishMessage;
  sizeBytes: number;
};

export type FileEventSpoolOpenOptions = InMemoryEventSpoolOptions & {
  maxPendingBytes?: number;
};

export type FileEventSpoolStoreOptions = {
  rootDirectory: string;
  maxSpoolDirectories?: number;
};

export type FileEventSpoolReplayResult = SupervisorEventSpoolRecoveryResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validIdentity(value: unknown, description: string): string {
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

function nonNegativeSafeInteger(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EventSpoolError(`${description} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, maximum: number, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new EventSpoolError(`${description} is outside its supported range`);
  }
  return value;
}

function assignmentDirectoryName(sessionId: string, leaseId: string, fencingToken: number): string {
  return sha256(
    `agent-dock.event-spool-assignment.v1\0${sessionId}\0${leaseId}\0${String(fencingToken)}`,
  );
}

function manifestBytes(state: EventSpoolManifestState): Buffer {
  const stateJson = JSON.stringify(state);
  const envelope: EventSpoolManifestEnvelope = {
    format: "agent-dock.event-spool-manifest.v1",
    sha256: sha256(stateJson),
    state,
  };
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

function eventBytes(message: EventPublishMessage): Buffer {
  const messageJson = JSON.stringify(message);
  if (Buffer.byteLength(messageJson, "utf8") > MAX_FILE_EVENT_SPOOL_MESSAGE_BYTES) {
    throw new EventSpoolError("Event publication exceeds the durable spool message limit");
  }
  const envelope: EventSpoolFileEnvelope = {
    format: "agent-dock.event-spool-event.v1",
    sha256: sha256(messageJson),
    message,
  };
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

function parseManifest(bytes: Buffer): EventSpoolManifestState {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new EventSpoolError("Durable event spool manifest is not valid JSON");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["format", "sha256", "state"]) ||
    value.format !== "agent-dock.event-spool-manifest.v1" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !isRecord(value.state) ||
    !hasExactKeys(value.state, [
      "sessionId",
      "leaseId",
      "fencingToken",
      "acknowledgedThroughSeq",
      "maxPendingEvents",
      "maxPendingBytes",
    ])
  ) {
    throw new EventSpoolError("Durable event spool manifest shape is invalid");
  }
  const state: EventSpoolManifestState = {
    sessionId: validIdentity(value.state.sessionId, "Manifest session ID"),
    leaseId: validIdentity(value.state.leaseId, "Manifest lease ID"),
    fencingToken: positiveSafeInteger(
      value.state.fencingToken,
      Number.MAX_SAFE_INTEGER,
      "Manifest fencing token",
    ),
    acknowledgedThroughSeq: nonNegativeSafeInteger(
      value.state.acknowledgedThroughSeq,
      "Manifest ACK cursor",
    ),
    maxPendingEvents: positiveSafeInteger(
      value.state.maxPendingEvents,
      MAX_PENDING_EVENTS_HARD_LIMIT,
      "Manifest event capacity",
    ),
    maxPendingBytes: positiveSafeInteger(
      value.state.maxPendingBytes,
      MAX_PENDING_BYTES_HARD_LIMIT,
      "Manifest byte capacity",
    ),
  };
  const expected = manifestBytes(state);
  if (value.sha256 !== sha256(JSON.stringify(state)) || !bytes.equals(expected)) {
    throw new EventSpoolError("Durable event spool manifest failed integrity validation");
  }
  return state;
}

function parseEventFile(bytes: Buffer): EventPublishMessage {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new EventSpoolError("Durable event spool entry is not valid JSON");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["format", "sha256", "message"]) ||
    value.format !== "agent-dock.event-spool-event.v1" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new EventSpoolError("Durable event spool entry shape is invalid");
  }
  let message: EventPublishMessage;
  try {
    const parsed = parseSupervisorToControlMessage(value.message);
    if (parsed.type !== "event.publish") {
      throw new EventSpoolError("Durable event spool entry is not event.publish");
    }
    message = parsed;
  } catch (error: unknown) {
    if (error instanceof EventSpoolError) throw error;
    throw new EventSpoolError("Durable event spool entry failed wire validation");
  }
  const expected = eventBytes(message);
  if (value.sha256 !== sha256(JSON.stringify(message)) || !bytes.equals(expected)) {
    throw new EventSpoolError("Durable event spool entry failed integrity validation");
  }
  return message;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new EventSpoolError("Durable event spool directory is not a private regular directory");
  }
}

async function readPrivateFile(path: string, maximumBytes: number, description: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new EventSpoolError(`${description} is outside its byte limit`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      throw new EventSpoolError(`${description} is outside its byte limit`);
    }
    return bytes;
  } catch (error: unknown) {
    if (error instanceof EventSpoolError) throw error;
    throw new EventSpoolError(`${description} could not be read safely`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectAssignmentDirectory(directory: string, requireComplete: boolean) {
  const entries = await readdir(directory, { withFileTypes: true });
  let manifestFound = false;
  let eventsFound = false;
  let cleaned = false;
  for (const entry of entries) {
    if (TEMPORARY_FILE_PATTERN.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
      await rm(resolve(directory, entry.name), { force: true });
      cleaned = true;
      continue;
    }
    if (entry.name === MANIFEST_FILE && entry.isFile() && !entry.isSymbolicLink()) {
      manifestFound = true;
      continue;
    }
    if (entry.name === EVENTS_DIRECTORY && entry.isDirectory() && !entry.isSymbolicLink()) {
      eventsFound = true;
      continue;
    }
    throw new EventSpoolError("Durable event spool assignment contains an unsupported entry");
  }
  if (requireComplete && (!manifestFound || !eventsFound)) {
    throw new EventSpoolError("Durable event spool assignment is incomplete");
  }
  if (cleaned) await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
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

async function publishNoOverwrite(target: string, bytes: Buffer): Promise<boolean> {
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

async function replaceAtomically(target: string, bytes: Buffer): Promise<void> {
  const directory = resolve(target, "..");
  const temporary = await writeTemporaryFile(directory, bytes);
  try {
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parsePublish(value: unknown): EventPublishMessage {
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

function parseAck(value: unknown): EventAckMessage {
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

export class FileEventSpool implements SupervisorEventSpool {
  readonly #eventsDirectory: string;
  readonly #manifestPath: string;
  readonly #maxPendingEvents: number;
  readonly #maxPendingBytes: number;
  readonly #pending = new Map<number, PendingEvent>();
  #sessionId: string;
  #leaseId: string;
  #fencingToken: number;
  #acknowledgedThroughSeq: number;
  #pendingBytes = 0;
  #operations: Promise<void> = Promise.resolve();

  private constructor(directory: string, state: EventSpoolManifestState) {
    this.#eventsDirectory = resolve(directory, EVENTS_DIRECTORY);
    this.#manifestPath = resolve(directory, MANIFEST_FILE);
    this.#sessionId = state.sessionId;
    this.#leaseId = state.leaseId;
    this.#fencingToken = state.fencingToken;
    this.#acknowledgedThroughSeq = state.acknowledgedThroughSeq;
    this.#maxPendingEvents = state.maxPendingEvents;
    this.#maxPendingBytes = state.maxPendingBytes;
  }

  static async load(directory: string, state: EventSpoolManifestState): Promise<FileEventSpool> {
    const spool = new FileEventSpool(directory, state);
    await spool.#loadPending();
    return spool;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get leaseId(): string {
    return this.#leaseId;
  }

  get fencingToken(): number {
    return this.#fencingToken;
  }

  get acknowledgedThroughSeq(): number {
    return this.#acknowledgedThroughSeq;
  }

  get highestProducedSeq(): number {
    return Math.max(this.#acknowledgedThroughSeq, ...this.#pending.keys());
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get maxPendingEvents(): number {
    return this.#maxPendingEvents;
  }

  get maxPendingBytes(): number {
    return this.#maxPendingBytes;
  }

  append(value: unknown): Promise<EventSpoolAppendResult> {
    return this.#serialize(() => this.#append(value));
  }

  acknowledge(value: unknown): Promise<EventSpoolAckResult> {
    return this.#serialize(() => this.#acknowledge(value));
  }

  replayAfter(sequence: number): readonly EventPublishMessage[] {
    nonNegativeSafeInteger(sequence, "Replay sequence");
    if (sequence < this.#acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `Cannot replay after ${sequence}; events are retained only after ACK ${this.#acknowledgedThroughSeq}`,
      );
    }
    if (sequence > this.highestProducedSeq) {
      throw new EventSpoolError(
        `Cannot replay after ${sequence}; highest published sequence is ${this.highestProducedSeq}`,
      );
    }
    return [...this.#pending.entries()]
      .filter(([eventSequence]) => eventSequence > sequence)
      .sort(([left], [right]) => left - right)
      .map(([, pending]) => pending.message);
  }

  async #append(value: unknown): Promise<EventSpoolAppendResult> {
    const message = parsePublish(value);
    this.#assertPublishAssignment(message);
    const sequence = message.payload.event.seq;
    if (sequence <= this.#acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `Cannot append sequence ${sequence}; it is already acknowledged through ${this.#acknowledgedThroughSeq}`,
      );
    }
    const existing = this.#pending.get(sequence);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing.message.payload, message.payload)) return "duplicate";
      throw new EventSpoolError(`Conflicting event publication at sequence ${sequence}`);
    }
    const expectedSequence = this.highestProducedSeq + 1;
    if (sequence !== expectedSequence) {
      throw new EventSpoolError(
        `Expected contiguous sequence ${expectedSequence}, received ${sequence}`,
      );
    }
    if (this.#pending.size >= this.#maxPendingEvents) {
      throw new EventSpoolError(
        `Event spool is full at ${this.#maxPendingEvents} unacknowledged events`,
      );
    }
    const bytes = eventBytes(message);
    if (this.#pendingBytes + bytes.byteLength > this.#maxPendingBytes) {
      throw new EventSpoolError(
        `Event spool is full at ${this.#maxPendingBytes} unacknowledged bytes`,
      );
    }
    const path = this.#eventPath(sequence);
    const created = await publishNoOverwrite(path, bytes);
    if (!created) {
      const persistedBytes = await readPrivateFile(
        path,
        MAX_EVENT_FILE_BYTES,
        "Durable event spool entry",
      );
      const persisted = parseEventFile(persistedBytes);
      this.#assertPersistedEvent(sequence, persisted);
      if (!isDeepStrictEqual(persisted.payload, message.payload)) {
        throw new EventSpoolError(`Conflicting event publication at sequence ${sequence}`);
      }
      this.#pending.set(sequence, { message: persisted, sizeBytes: persistedBytes.byteLength });
      this.#pendingBytes += persistedBytes.byteLength;
      return "duplicate";
    }
    this.#pending.set(sequence, { message, sizeBytes: bytes.byteLength });
    this.#pendingBytes += bytes.byteLength;
    return "appended";
  }

  async #acknowledge(value: unknown): Promise<EventSpoolAckResult> {
    const message = parseAck(value);
    this.#assertAckAssignment(message);
    const throughSequence = message.payload.acknowledgedThroughSeq;
    if (throughSequence < this.#acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `ACK regression from ${this.#acknowledgedThroughSeq} to ${throughSequence}`,
      );
    }
    if (throughSequence === this.#acknowledgedThroughSeq) {
      return {
        acknowledgedThroughSeq: this.#acknowledgedThroughSeq,
        removedCount: 0,
        duplicate: true,
      };
    }
    if (throughSequence > this.highestProducedSeq) {
      throw new EventSpoolError(
        `ACK ${throughSequence} exceeds highest published sequence ${this.highestProducedSeq}`,
      );
    }
    const removableSequences = [...this.#pending.keys()]
      .filter((sequence) => sequence <= throughSequence)
      .sort((left, right) => left - right);
    const expectedRemovalCount = throughSequence - this.#acknowledgedThroughSeq;
    if (removableSequences.length !== expectedRemovalCount) {
      throw new EventSpoolError(
        `Cannot cumulatively ACK through ${throughSequence}; the local spool contains a sequence gap`,
      );
    }

    const nextState = this.#state(throughSequence);
    await replaceAtomically(this.#manifestPath, manifestBytes(nextState));
    this.#acknowledgedThroughSeq = throughSequence;
    for (const sequence of removableSequences) {
      const pending = this.#pending.get(sequence);
      if (pending !== undefined) this.#pendingBytes -= pending.sizeBytes;
      this.#pending.delete(sequence);
    }
    try {
      await Promise.all(
        removableSequences.map((sequence) => rm(this.#eventPath(sequence), { force: true })),
      );
      await syncDirectory(this.#eventsDirectory);
    } catch {
      throw new EventSpoolError("Acknowledged event files could not be compacted safely");
    }
    return {
      acknowledgedThroughSeq: throughSequence,
      removedCount: removableSequences.length,
      duplicate: false,
    };
  }

  async #loadPending(): Promise<void> {
    await ensurePrivateDirectory(this.#eventsDirectory);
    const entries = await readdir(this.#eventsDirectory, { withFileTypes: true });
    let cleaned = false;
    const candidates: Array<{ sequence: number; name: string }> = [];
    for (const entry of entries) {
      if (TEMPORARY_FILE_PATTERN.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
        await rm(resolve(this.#eventsDirectory, entry.name), { force: true });
        cleaned = true;
        continue;
      }
      const match = EVENT_FILE_PATTERN.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        throw new EventSpoolError("Durable event spool contains an unsupported entry");
      }
      const sequence = Number(match[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new EventSpoolError("Durable event spool contains an invalid sequence file");
      }
      if (sequence <= this.#acknowledgedThroughSeq) {
        await rm(resolve(this.#eventsDirectory, entry.name), { force: true });
        cleaned = true;
        continue;
      }
      candidates.push({ sequence, name: entry.name });
    }
    candidates.sort((left, right) => left.sequence - right.sequence);
    let expectedSequence = this.#acknowledgedThroughSeq + 1;
    for (const candidate of candidates) {
      if (candidate.sequence !== expectedSequence) {
        throw new EventSpoolError(
          `Durable event spool expected sequence ${expectedSequence}, found ${candidate.sequence}`,
        );
      }
      const bytes = await readPrivateFile(
        resolve(this.#eventsDirectory, candidate.name),
        MAX_EVENT_FILE_BYTES,
        "Durable event spool entry",
      );
      const message = parseEventFile(bytes);
      this.#assertPersistedEvent(candidate.sequence, message);
      if (this.#pending.size >= this.#maxPendingEvents) {
        throw new EventSpoolError("Durable event spool exceeds its event capacity");
      }
      if (this.#pendingBytes + bytes.byteLength > this.#maxPendingBytes) {
        throw new EventSpoolError("Durable event spool exceeds its byte capacity");
      }
      this.#pending.set(candidate.sequence, { message, sizeBytes: bytes.byteLength });
      this.#pendingBytes += bytes.byteLength;
      expectedSequence += 1;
    }
    if (cleaned) await syncDirectory(this.#eventsDirectory);
  }

  #assertPersistedEvent(sequence: number, message: EventPublishMessage): void {
    this.#assertPublishAssignment(message);
    if (message.payload.event.seq !== sequence) {
      throw new EventSpoolError("Durable event spool filename does not match its event sequence");
    }
  }

  #assertPublishAssignment(message: EventPublishMessage): void {
    if (message.payload.event.sessionId !== this.#sessionId) {
      throw new EventSpoolError("Event session does not match its durable spool assignment");
    }
    this.#assertLease(message.payload.leaseId, message.payload.fencingToken);
  }

  #assertAckAssignment(message: EventAckMessage): void {
    if (message.payload.sessionId !== this.#sessionId) {
      throw new EventSpoolError("ACK session does not match its durable spool assignment");
    }
    this.#assertLease(message.payload.leaseId, message.payload.fencingToken);
  }

  #assertLease(leaseId: string, fencingToken: number): void {
    if (leaseId !== this.#leaseId || fencingToken !== this.#fencingToken) {
      throw new EventSpoolError("Event spool message belongs to a stale assignment");
    }
  }

  #state(acknowledgedThroughSeq: number): EventSpoolManifestState {
    return {
      sessionId: this.#sessionId,
      leaseId: this.#leaseId,
      fencingToken: this.#fencingToken,
      acknowledgedThroughSeq,
      maxPendingEvents: this.#maxPendingEvents,
      maxPendingBytes: this.#maxPendingBytes,
    };
  }

  #eventPath(sequence: number): string {
    return resolve(this.#eventsDirectory, `${String(sequence)}.json`);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class FileEventSpoolStore implements SupervisorEventSpoolRecovery {
  readonly #rootDirectory: string;
  readonly #maxSpoolDirectories: number;
  readonly #opened = new Map<string, Promise<FileEventSpool>>();

  constructor(options: FileEventSpoolStoreOptions) {
    if (options.rootDirectory.trim().length === 0) {
      throw new TypeError("rootDirectory must not be empty");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#maxSpoolDirectories = positiveSafeInteger(
      options.maxSpoolDirectories ?? MAX_FILE_EVENT_SPOOL_DIRECTORIES,
      MAX_FILE_EVENT_SPOOL_DIRECTORIES,
      "Spool directory capacity",
    );
  }

  async open(options: FileEventSpoolOpenOptions): Promise<FileEventSpool> {
    const state = this.#stateFromOptions(options);
    const name = assignmentDirectoryName(state.sessionId, state.leaseId, state.fencingToken);
    return this.#openNamed(name, state);
  }

  async redeliverPending(
    publishEvent: (message: EventPublishMessage) => Promise<EventAckMessage> | EventAckMessage,
  ): Promise<FileEventSpoolReplayResult> {
    await ensurePrivateDirectory(this.#rootDirectory);
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    if (entries.length > this.#maxSpoolDirectories) {
      throw new EventSpoolError("Durable event spool root exceeds its directory capacity");
    }
    const spools: FileEventSpool[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (
        !SPOOL_DIRECTORY_PATTERN.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw new EventSpoolError("Durable event spool root contains an unsupported entry");
      }
      spools.push(await this.#openExisting(entry.name));
    }
    spools.sort(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.fencingToken - right.fencingToken ||
        left.leaseId.localeCompare(right.leaseId),
    );

    let replayedSpools = 0;
    let replayedEvents = 0;
    for (const spool of spools) {
      const pending = spool.replayAfter(spool.acknowledgedThroughSeq);
      if (pending.length === 0) continue;
      replayedSpools += 1;
      for (const message of pending) {
        if (message.payload.event.seq <= spool.acknowledgedThroughSeq) continue;
        const acknowledgement = await publishEvent(message);
        await spool.acknowledge(acknowledgement);
        replayedEvents += 1;
      }
    }
    return { scannedSpools: spools.length, replayedSpools, replayedEvents };
  }

  async #openExisting(name: string): Promise<FileEventSpool> {
    const existing = this.#opened.get(name);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const directory = resolve(this.#rootDirectory, name);
      await ensurePrivateDirectory(directory);
      await inspectAssignmentDirectory(directory, true);
      const state = parseManifest(
        await readPrivateFile(
          resolve(directory, MANIFEST_FILE),
          MAX_MANIFEST_BYTES,
          "Durable event spool manifest",
        ),
      );
      if (assignmentDirectoryName(state.sessionId, state.leaseId, state.fencingToken) !== name) {
        throw new EventSpoolError("Durable event spool directory identity is invalid");
      }
      return FileEventSpool.load(directory, state);
    })();
    this.#opened.set(name, operation);
    operation.catch(() => this.#opened.delete(name));
    return operation;
  }

  async #openNamed(name: string, expected: EventSpoolManifestState): Promise<FileEventSpool> {
    const existing = this.#opened.get(name);
    if (existing !== undefined) {
      const spool = await existing;
      this.#assertExpected(spool, expected);
      return spool;
    }
    const operation = (async () => {
      await ensurePrivateDirectory(this.#rootDirectory);
      const rootEntries = await readdir(this.#rootDirectory);
      if (!rootEntries.includes(name) && rootEntries.length >= this.#maxSpoolDirectories) {
        throw new EventSpoolError("Durable event spool root is full");
      }
      const directory = resolve(this.#rootDirectory, name);
      await ensurePrivateDirectory(directory);
      await inspectAssignmentDirectory(directory, false);
      await ensurePrivateDirectory(resolve(directory, EVENTS_DIRECTORY));
      const manifestPath = resolve(directory, MANIFEST_FILE);
      const created = await publishNoOverwrite(manifestPath, manifestBytes(expected));
      const state = created
        ? expected
        : parseManifest(
            await readPrivateFile(manifestPath, MAX_MANIFEST_BYTES, "Durable event spool manifest"),
          );
      if (!isDeepStrictEqual(state, expected)) {
        throw new EventSpoolError("Durable event spool assignment identity or cursor changed");
      }
      return FileEventSpool.load(directory, state);
    })();
    this.#opened.set(name, operation);
    operation.catch(() => this.#opened.delete(name));
    return operation;
  }

  #stateFromOptions(options: FileEventSpoolOpenOptions): EventSpoolManifestState {
    return {
      sessionId: validIdentity(options.sessionId, "Spool session ID"),
      leaseId: validIdentity(options.leaseId, "Spool lease ID"),
      fencingToken: positiveSafeInteger(
        options.fencingToken,
        Number.MAX_SAFE_INTEGER,
        "Spool fencing token",
      ),
      acknowledgedThroughSeq: nonNegativeSafeInteger(
        options.acknowledgedThroughSeq ?? 0,
        "Spool ACK cursor",
      ),
      maxPendingEvents: positiveSafeInteger(
        options.maxPendingEvents ?? 10_000,
        MAX_PENDING_EVENTS_HARD_LIMIT,
        "Spool event capacity",
      ),
      maxPendingBytes: positiveSafeInteger(
        options.maxPendingBytes ?? DEFAULT_FILE_EVENT_SPOOL_BYTES,
        MAX_PENDING_BYTES_HARD_LIMIT,
        "Spool byte capacity",
      ),
    };
  }

  #assertExpected(spool: FileEventSpool, expected: EventSpoolManifestState): void {
    if (
      spool.sessionId !== expected.sessionId ||
      spool.leaseId !== expected.leaseId ||
      spool.fencingToken !== expected.fencingToken ||
      spool.acknowledgedThroughSeq !== expected.acknowledgedThroughSeq ||
      spool.maxPendingEvents !== expected.maxPendingEvents ||
      spool.maxPendingBytes !== expected.maxPendingBytes
    ) {
      throw new EventSpoolError("Durable event spool assignment identity or cursor changed");
    }
  }
}
