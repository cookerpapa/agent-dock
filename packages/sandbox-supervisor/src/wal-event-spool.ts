import type { EventAckMessage, EventPublishMessage } from "@pi-cloud/protocol";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  EventDeliveryRejectedError,
  EventSpoolError,
  type EventSpoolAckResult,
  type EventSpoolAppendResult,
  type SupervisorEventSpool,
  type SupervisorEventSpoolRecovery,
} from "./in-memory-event-spool.ts";
import {
  DEFAULT_WAL_EVENT_SPOOL_BYTES,
  MAX_PENDING_BYTES_HARD_LIMIT,
  MAX_PENDING_EVENTS_HARD_LIMIT,
  MAX_WAL_EVENT_SPOOL_FILES,
  TEMPORARY_FILE_PATTERN,
  WAL_FILE_PATTERN,
  appendDurably,
  assertPublishAssignment,
  assignmentName,
  ensurePrivateDirectory,
  errorCode,
  isInside,
  loadWal,
  nonNegativeSafeInteger,
  parseAck,
  parsePublish,
  positiveSafeInteger,
  publishNoOverwrite,
  recordBytes,
  replaceAtomically,
  syncDirectory,
  validDate,
  validIdentity,
  type AssignmentRecord,
  type EventRecord,
  type LoadedWal,
  type PendingEvent,
  type RejectionRecord,
  type WalEventSpoolOpenOptions,
  type WalEventSpoolReplayResult,
  type WalEventSpoolStoreOptions,
} from "./wal-event-spool-codec.ts";

export {
  DEFAULT_WAL_EVENT_SPOOL_BYTES,
  MAX_WAL_EVENT_SPOOL_FILES,
  MAX_WAL_EVENT_SPOOL_MESSAGE_BYTES,
  type WalEventSpoolOpenOptions,
  type WalEventSpoolReplayResult,
  type WalEventSpoolStoreOptions,
} from "./wal-event-spool-codec.ts";

export class WalEventSpool implements SupervisorEventSpool {
  readonly #path: string;
  readonly #assignment: AssignmentRecord;
  readonly #pending: Map<number, PendingEvent>;
  #pendingBytes: number;
  #highestProducedSeq: number;
  #walBytes: number;
  #rejected: boolean;
  #operations: Promise<void> = Promise.resolve();

  private constructor(path: string, loaded: LoadedWal) {
    this.#path = path;
    this.#assignment = loaded.assignment;
    this.#pending = loaded.pending;
    this.#pendingBytes = loaded.pendingBytes;
    this.#highestProducedSeq = loaded.highestProducedSeq;
    this.#walBytes = loaded.walBytes;
    this.#rejected = loaded.rejected;
  }

  static async load(path: string): Promise<WalEventSpool> {
    return new WalEventSpool(path, await loadWal(path));
  }

  get sessionId(): string {
    return this.#assignment.sessionId;
  }

  get leaseId(): string {
    return this.#assignment.leaseId;
  }

  get fencingToken(): number {
    return this.#assignment.fencingToken;
  }

  get acknowledgedThroughSeq(): number {
    return this.#assignment.acknowledgedThroughSeq;
  }

  get highestProducedSeq(): number {
    return this.#highestProducedSeq;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get maxPendingEvents(): number {
    return this.#assignment.maxPendingEvents;
  }

  get maxPendingBytes(): number {
    return this.#assignment.maxPendingBytes;
  }

  get rejected(): boolean {
    return this.#rejected;
  }

  append(value: unknown): Promise<EventSpoolAppendResult> {
    return this.#serialize(() => this.#append(value));
  }

  acknowledge(value: unknown): Promise<EventSpoolAckResult> {
    return this.#serialize(() => this.#acknowledge(value));
  }

  replayAfter(sequence: number): readonly EventPublishMessage[] {
    nonNegativeSafeInteger(sequence, "Replay sequence");
    if (sequence < this.acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `Cannot replay after ${sequence}; events are retained only after ACK ${this.acknowledgedThroughSeq}`,
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

  markRejected(rejection: EventDeliveryRejectedError, rejectedAt: Date): Promise<number> {
    return this.#serialize(async () => {
      if (
        this.#rejected ||
        rejection.code !== "stale_fence" ||
        rejection.sessionId !== this.sessionId ||
        rejection.leaseId !== this.leaseId ||
        rejection.fencingToken !== this.fencingToken ||
        rejection.rejectedSeq <= this.acknowledgedThroughSeq ||
        rejection.rejectedSeq > this.highestProducedSeq
      ) {
        throw new EventSpoolError("Event rejection does not match its durable spool assignment");
      }
      const record: RejectionRecord = {
        kind: "rejection",
        sessionId: this.sessionId,
        leaseId: this.leaseId,
        fencingToken: this.fencingToken,
        rejectedSeq: rejection.rejectedSeq,
        code: rejection.code,
        rejectedAt: rejectedAt.toISOString(),
      };
      const bytes = recordBytes(record);
      await appendDurably(this.#path, bytes);
      this.#walBytes += bytes.byteLength;
      this.#rejected = true;
      return this.pendingCount;
    });
  }

  async #append(value: unknown): Promise<EventSpoolAppendResult> {
    if (this.#rejected) throw new EventSpoolError("Event spool assignment was rejected");
    const message = parsePublish(value);
    assertPublishAssignment(this.#assignment, message);
    const sequence = message.payload.event.seq;
    if (sequence <= this.acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `Cannot append sequence ${sequence}; it is already acknowledged through ${this.acknowledgedThroughSeq}`,
      );
    }
    const existing = this.#pending.get(sequence);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing.message.payload, message.payload)) return "duplicate";
      throw new EventSpoolError(`Conflicting event publication at sequence ${sequence}`);
    }
    if (sequence !== this.highestProducedSeq + 1) {
      throw new EventSpoolError(
        `Expected contiguous sequence ${this.highestProducedSeq + 1}, received ${sequence}`,
      );
    }
    if (this.pendingCount >= this.maxPendingEvents) {
      throw new EventSpoolError(
        `Event spool is full at ${this.maxPendingEvents} unacknowledged events`,
      );
    }
    const record: EventRecord = { kind: "event", sequence, message };
    const bytes = recordBytes(record);
    if (this.#pendingBytes + bytes.byteLength > this.maxPendingBytes) {
      throw new EventSpoolError(
        `Event spool is full at ${this.maxPendingBytes} unacknowledged bytes`,
      );
    }
    await appendDurably(this.#path, bytes);
    this.#pending.set(sequence, { message, sizeBytes: bytes.byteLength });
    this.#pendingBytes += bytes.byteLength;
    this.#highestProducedSeq = sequence;
    this.#walBytes += bytes.byteLength;
    return "appended";
  }

  async #acknowledge(value: unknown): Promise<EventSpoolAckResult> {
    if (this.#rejected) throw new EventSpoolError("Event spool assignment was rejected");
    const message = parseAck(value);
    if (
      message.payload.sessionId !== this.sessionId ||
      message.payload.leaseId !== this.leaseId ||
      message.payload.fencingToken !== this.fencingToken
    ) {
      throw new EventSpoolError("Event spool message belongs to a stale assignment");
    }
    const throughSequence = message.payload.acknowledgedThroughSeq;
    if (throughSequence < this.acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `ACK regression from ${this.acknowledgedThroughSeq} to ${throughSequence}`,
      );
    }
    if (throughSequence === this.acknowledgedThroughSeq) {
      return {
        acknowledgedThroughSeq: this.acknowledgedThroughSeq,
        removedCount: 0,
        duplicate: true,
      };
    }
    if (throughSequence > this.highestProducedSeq) {
      throw new EventSpoolError(
        `ACK ${throughSequence} exceeds highest published sequence ${this.highestProducedSeq}`,
      );
    }
    const removable = [...this.#pending.keys()]
      .filter((sequence) => sequence <= throughSequence)
      .sort((left, right) => left - right);
    if (removable.length !== throughSequence - this.acknowledgedThroughSeq) {
      throw new EventSpoolError(
        `Cannot cumulatively ACK through ${throughSequence}; the local spool contains a sequence gap`,
      );
    }
    const bytes = recordBytes({ kind: "ack", acknowledgedThroughSeq: throughSequence });
    await appendDurably(this.#path, bytes);
    this.#walBytes += bytes.byteLength;
    this.#assignment.acknowledgedThroughSeq = throughSequence;
    for (const sequence of removable) {
      const pending = this.#pending.get(sequence)!;
      this.#pending.delete(sequence);
      this.#pendingBytes -= pending.sizeBytes;
    }
    if (
      this.pendingCount === 0 ||
      this.#walBytes > Math.max(1 * 1_024 * 1_024, this.#pendingBytes * 2)
    ) {
      await this.#compact();
    }
    return {
      acknowledgedThroughSeq: throughSequence,
      removedCount: removable.length,
      duplicate: false,
    };
  }

  async #compact(): Promise<void> {
    const chunks = [recordBytes({ ...this.#assignment })];
    for (const [sequence, pending] of [...this.#pending.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      chunks.push(recordBytes({ kind: "event", sequence, message: pending.message }));
    }
    const bytes = Buffer.concat(chunks);
    await replaceAtomically(this.#path, bytes);
    this.#walBytes = bytes.byteLength;
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

export class WalEventSpoolStore implements SupervisorEventSpoolRecovery {
  readonly #rootDirectory: string;
  readonly #quarantineDirectory: string;
  readonly #maxSpoolFiles: number;
  readonly #clock: () => Date;
  readonly #opened = new Map<string, Promise<WalEventSpool>>();

  constructor(options: WalEventSpoolStoreOptions) {
    if (options.rootDirectory.trim().length === 0) {
      throw new TypeError("rootDirectory must not be empty");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#quarantineDirectory = resolve(
      options.quarantineDirectory ?? `${this.#rootDirectory}.quarantine`,
    );
    if (
      isInside(this.#rootDirectory, this.#quarantineDirectory) ||
      isInside(this.#quarantineDirectory, this.#rootDirectory)
    ) {
      throw new TypeError("event spool active and quarantine directories must be separate");
    }
    this.#maxSpoolFiles = positiveSafeInteger(
      options.maxSpoolFiles ?? MAX_WAL_EVENT_SPOOL_FILES,
      MAX_WAL_EVENT_SPOOL_FILES,
      "Spool file capacity",
    );
    this.#clock = options.clock ?? (() => new Date());
  }

  async open(options: WalEventSpoolOpenOptions): Promise<WalEventSpool> {
    const assignment = this.#assignmentFromOptions(options);
    return this.#openAssignment(assignment);
  }

  async redeliverPending(
    publishEvent: (message: EventPublishMessage) => Promise<EventAckMessage> | EventAckMessage,
  ): Promise<WalEventSpoolReplayResult> {
    const names = await this.#activeWalNames();
    const spools = await Promise.all(
      names.map(async (name) => ({ name, spool: await this.#openExisting(name) })),
    );
    spools.sort(
      (left, right) =>
        left.spool.sessionId.localeCompare(right.spool.sessionId) ||
        left.spool.fencingToken - right.spool.fencingToken ||
        left.spool.leaseId.localeCompare(right.spool.leaseId),
    );
    let replayedSpools = 0;
    let replayedEvents = 0;
    let quarantinedSpools = 0;
    let quarantinedEvents = 0;
    for (const { name, spool } of spools) {
      if (spool.rejected) {
        quarantinedSpools += 1;
        quarantinedEvents += spool.pendingCount;
        await this.#quarantine(name);
        continue;
      }
      const pending = spool.replayAfter(spool.acknowledgedThroughSeq);
      if (pending.length === 0) continue;
      replayedSpools += 1;
      for (const message of pending) {
        let acknowledgement: EventAckMessage;
        try {
          acknowledgement = await publishEvent(message);
        } catch (error: unknown) {
          if (
            !(error instanceof EventDeliveryRejectedError) ||
            error.sessionId !== message.payload.event.sessionId ||
            error.leaseId !== message.payload.leaseId ||
            error.fencingToken !== message.payload.fencingToken ||
            error.rejectedSeq !== message.payload.event.seq
          ) {
            throw error;
          }
          quarantinedEvents += await spool.markRejected(error, validDate(this.#clock));
          await this.#quarantine(name);
          quarantinedSpools += 1;
          break;
        }
        await spool.acknowledge(acknowledgement);
        replayedEvents += 1;
      }
    }
    return {
      scannedSpools: spools.length,
      replayedSpools,
      replayedEvents,
      quarantinedSpools,
      quarantinedEvents,
    };
  }

  async #activeWalNames(): Promise<string[]> {
    await ensurePrivateDirectory(this.#rootDirectory);
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    const names: string[] = [];
    let cleaned = false;
    for (const entry of entries) {
      if (TEMPORARY_FILE_PATTERN.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
        await rm(resolve(this.#rootDirectory, entry.name), { force: true });
        cleaned = true;
        continue;
      }
      if (!WAL_FILE_PATTERN.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new EventSpoolError("Durable event spool root contains an unsupported entry");
      }
      names.push(entry.name);
    }
    if (names.length > this.#maxSpoolFiles) {
      throw new EventSpoolError("Durable event spool root exceeds its file capacity");
    }
    if (cleaned) await syncDirectory(this.#rootDirectory);
    return names.sort();
  }

  async #openExisting(name: string): Promise<WalEventSpool> {
    const existing = this.#opened.get(name);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const spool = await WalEventSpool.load(resolve(this.#rootDirectory, name));
      if (`${assignmentName(spool.sessionId, spool.leaseId, spool.fencingToken)}.wal` !== name) {
        throw new EventSpoolError("Durable event WAL filename identity is invalid");
      }
      return spool;
    })();
    this.#opened.set(name, operation);
    operation.catch(() => this.#opened.delete(name));
    return operation;
  }

  async #openAssignment(expected: AssignmentRecord): Promise<WalEventSpool> {
    await ensurePrivateDirectory(this.#rootDirectory);
    const name = `${assignmentName(
      expected.sessionId,
      expected.leaseId,
      expected.fencingToken,
    )}.wal`;
    const existing = this.#opened.get(name);
    if (existing !== undefined) {
      const spool = await existing;
      this.#assertExpected(spool, expected);
      return spool;
    }
    const operation = (async () => {
      const names = await this.#activeWalNames();
      if (!names.includes(name) && names.length >= this.#maxSpoolFiles) {
        throw new EventSpoolError("Durable event spool root is full");
      }
      const path = resolve(this.#rootDirectory, name);
      await publishNoOverwrite(path, recordBytes(expected));
      const spool = await WalEventSpool.load(path);
      this.#assertExpected(spool, expected);
      return spool;
    })();
    this.#opened.set(name, operation);
    operation.catch(() => this.#opened.delete(name));
    return operation;
  }

  async #quarantine(name: string): Promise<void> {
    await ensurePrivateDirectory(this.#quarantineDirectory);
    const source = resolve(this.#rootDirectory, name);
    const target = resolve(this.#quarantineDirectory, name);
    try {
      await lstat(target);
      throw new EventSpoolError("Durable event spool quarantine target already exists");
    } catch (error: unknown) {
      if (error instanceof EventSpoolError) throw error;
      if (errorCode(error) !== "ENOENT") {
        throw new EventSpoolError("Durable event spool quarantine target could not be inspected");
      }
    }
    try {
      await rename(source, target);
      await Promise.all([
        syncDirectory(this.#rootDirectory),
        syncDirectory(this.#quarantineDirectory),
      ]);
    } catch {
      throw new EventSpoolError("Durable event spool could not be quarantined safely");
    }
    this.#opened.delete(name);
  }

  #assignmentFromOptions(options: WalEventSpoolOpenOptions): AssignmentRecord {
    return {
      kind: "assignment",
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
        options.maxPendingBytes ?? DEFAULT_WAL_EVENT_SPOOL_BYTES,
        MAX_PENDING_BYTES_HARD_LIMIT,
        "Spool byte capacity",
      ),
    };
  }

  #assertExpected(spool: WalEventSpool, expected: AssignmentRecord): void {
    if (
      spool.sessionId !== expected.sessionId ||
      spool.leaseId !== expected.leaseId ||
      spool.fencingToken !== expected.fencingToken ||
      spool.acknowledgedThroughSeq !== expected.acknowledgedThroughSeq ||
      spool.maxPendingEvents !== expected.maxPendingEvents ||
      spool.maxPendingBytes !== expected.maxPendingBytes ||
      spool.rejected
    ) {
      throw new EventSpoolError("Durable event spool assignment identity or cursor changed");
    }
  }
}
