import type {
  SandboxManagerSnapshotGcRequest,
  SandboxManagerSnapshotGcResponse,
} from "@agent-dock/protocol";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  CubeSandboxRuntimeClient,
  CubeSandboxSnapshot,
} from "./cubesandbox-runtime-client.ts";
import { SandboxManagerError } from "./sandbox-provider.ts";

const STATE_FORMAT = "agent-dock.cube-snapshot-gc.v1";
const MANAGED_SNAPSHOT_NAME = /^adws-[0-9a-f]{48}$/;
const DEFAULT_GRACE_MS = 24 * 60 * 60_000;
const MAXIMUM_STATE_BYTES = 16 * 1_024 * 1_024;

type Candidate = Readonly<{
  snapshotId: string;
  name: string;
  firstUnreferencedAt: number;
  lastUnreferencedAt: number;
  observations: number;
}>;

type ReconcileResult = Readonly<{
  managedSnapshots: number;
  referencedSnapshots: number;
  candidates: number;
  deletedSnapshotIds: readonly string[];
  deletionEnabled: boolean;
}>;

type CollectorState = {
  format: typeof STATE_FORMAT;
  candidates: Record<string, Candidate>;
  lastScanId?: string;
  lastResult?: ReconcileResult;
};

export type CubeSnapshotGarbageCollectorOptions = Readonly<{
  runtime: CubeSandboxRuntimeClient;
  statePath: string;
  deletionEnabled?: boolean;
  graceMs?: number;
  maximumDeletesPerScan?: number;
  clock?: () => number;
}>;

function validInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseCandidate(value: unknown, key: string): Candidate {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { snapshotId?: unknown }).snapshotId !== key ||
    typeof (value as { name?: unknown }).name !== "string" ||
    !MANAGED_SNAPSHOT_NAME.test((value as { name: string }).name) ||
    !validTimestamp((value as { firstUnreferencedAt?: unknown }).firstUnreferencedAt) ||
    !validTimestamp((value as { lastUnreferencedAt?: unknown }).lastUnreferencedAt) ||
    !Number.isSafeInteger((value as { observations?: unknown }).observations) ||
    ((value as { observations: number }).observations ?? 0) < 1
  ) {
    throw new SandboxManagerError(
      "cube_snapshot_gc_state_invalid",
      "Cube snapshot garbage-collection state is invalid",
      false,
    );
  }
  const candidate = value as Candidate;
  if (candidate.firstUnreferencedAt > candidate.lastUnreferencedAt) {
    throw new SandboxManagerError(
      "cube_snapshot_gc_state_invalid",
      "Cube snapshot garbage-collection state is inconsistent",
      false,
    );
  }
  return Object.freeze({ ...candidate });
}

function parseResult(value: unknown): ReconcileResult | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Number.isSafeInteger((value as { managedSnapshots?: unknown }).managedSnapshots) ||
    !Number.isSafeInteger((value as { referencedSnapshots?: unknown }).referencedSnapshots) ||
    !Number.isSafeInteger((value as { candidates?: unknown }).candidates) ||
    !Array.isArray((value as { deletedSnapshotIds?: unknown }).deletedSnapshotIds) ||
    !(value as { deletedSnapshotIds: unknown[] }).deletedSnapshotIds.every(
      (item) => typeof item === "string",
    ) ||
    typeof (value as { deletionEnabled?: unknown }).deletionEnabled !== "boolean"
  ) {
    throw new SandboxManagerError(
      "cube_snapshot_gc_state_invalid",
      "Cube snapshot garbage-collection result is invalid",
      false,
    );
  }
  return Object.freeze({
    managedSnapshots: (value as { managedSnapshots: number }).managedSnapshots,
    referencedSnapshots: (value as { referencedSnapshots: number }).referencedSnapshots,
    candidates: (value as { candidates: number }).candidates,
    deletedSnapshotIds: Object.freeze([
      ...(value as { deletedSnapshotIds: string[] }).deletedSnapshotIds,
    ]),
    deletionEnabled: (value as { deletionEnabled: boolean }).deletionEnabled,
  });
}

function parseState(bytes: Uint8Array): CollectorState {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new SandboxManagerError(
      "cube_snapshot_gc_state_invalid",
      "Cube snapshot garbage-collection state is malformed",
      false,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { format?: unknown }).format !== STATE_FORMAT ||
    typeof (value as { candidates?: unknown }).candidates !== "object" ||
    (value as { candidates?: unknown }).candidates === null ||
    Array.isArray((value as { candidates?: unknown }).candidates) ||
    ((value as { lastScanId?: unknown }).lastScanId !== undefined &&
      typeof (value as { lastScanId?: unknown }).lastScanId !== "string")
  ) {
    throw new SandboxManagerError(
      "cube_snapshot_gc_state_invalid",
      "Cube snapshot garbage-collection state is invalid",
      false,
    );
  }
  const candidates = Object.fromEntries(
    Object.entries((value as { candidates: Record<string, unknown> }).candidates).map(
      ([key, candidate]) => [key, parseCandidate(candidate, key)],
    ),
  );
  const lastResult = parseResult((value as { lastResult?: unknown }).lastResult);
  return {
    format: STATE_FORMAT,
    candidates,
    ...((value as { lastScanId?: string }).lastScanId === undefined
      ? {}
      : { lastScanId: (value as { lastScanId: string }).lastScanId }),
    ...(lastResult === undefined ? {} : { lastResult }),
  };
}

function managedName(snapshot: CubeSandboxSnapshot): string | undefined {
  const names = snapshot.names.filter((name) => MANAGED_SNAPSHOT_NAME.test(name));
  return names.length === 1 ? names[0] : undefined;
}

export class CubeSnapshotGarbageCollector {
  readonly #runtime: CubeSandboxRuntimeClient;
  readonly #statePath: string;
  readonly #deletionEnabled: boolean;
  readonly #graceMs: number;
  readonly #maximumDeletesPerScan: number;
  readonly #clock: () => number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: CubeSnapshotGarbageCollectorOptions) {
    if (!isAbsolute(options.statePath) || options.statePath.includes("\0")) {
      throw new TypeError("Cube snapshot GC state path must be absolute");
    }
    this.#runtime = options.runtime;
    this.#statePath = resolve(options.statePath);
    this.#deletionEnabled = options.deletionEnabled ?? false;
    this.#graceMs = validInteger(
      options.graceMs ?? DEFAULT_GRACE_MS,
      DEFAULT_GRACE_MS,
      30 * 24 * 60 * 60_000,
      "Cube snapshot GC grace",
    );
    this.#maximumDeletesPerScan = validInteger(
      options.maximumDeletesPerScan ?? 25,
      1,
      100,
      "Cube snapshot GC delete limit",
    );
    this.#clock = options.clock ?? Date.now;
  }

  reconcile(request: SandboxManagerSnapshotGcRequest): Promise<SandboxManagerSnapshotGcResponse> {
    const task = this.#tail.then(() => this.#reconcile(request));
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #reconcile(
    request: SandboxManagerSnapshotGcRequest,
  ): Promise<SandboxManagerSnapshotGcResponse> {
    const now = validInteger(this.#clock(), 0, Number.MAX_SAFE_INTEGER, "Cube snapshot GC clock");
    const state = await this.#load();
    if (state.lastScanId === request.scanId && state.lastResult !== undefined) {
      return this.#response(request, state.lastResult);
    }

    const inventory = await this.#runtime.listSnapshots();
    const byId = new Map<string, CubeSandboxSnapshot>();
    for (const snapshot of inventory) {
      if (byId.has(snapshot.snapshotId)) {
        throw new SandboxManagerError(
          "cube_snapshot_inventory_invalid",
          "Cube snapshot inventory contained a duplicate identity",
          false,
        );
      }
      byId.set(snapshot.snapshotId, snapshot);
    }
    const referenced = new Set(request.referencedSnapshotIds);
    const missing = [...referenced].filter((snapshotId) => !byId.has(snapshotId));
    if (missing.length > 0) {
      throw new SandboxManagerError(
        "cube_snapshot_reference_missing",
        "A durable Workspace version references a missing Cube snapshot",
        false,
      );
    }

    const managed = inventory
      .map((snapshot) => ({ snapshot, name: managedName(snapshot) }))
      .filter(
        (entry): entry is { snapshot: CubeSandboxSnapshot; name: string } =>
          entry.name !== undefined,
      );
    const managedIds = new Set(managed.map(({ snapshot }) => snapshot.snapshotId));
    for (const snapshotId of Object.keys(state.candidates)) {
      if (!managedIds.has(snapshotId) || referenced.has(snapshotId)) {
        delete state.candidates[snapshotId];
      }
    }
    for (const { snapshot, name } of managed) {
      if (referenced.has(snapshot.snapshotId)) continue;
      const existing = state.candidates[snapshot.snapshotId];
      state.candidates[snapshot.snapshotId] =
        existing === undefined
          ? {
              snapshotId: snapshot.snapshotId,
              name,
              firstUnreferencedAt: now,
              lastUnreferencedAt: now,
              observations: 1,
            }
          : {
              ...existing,
              name,
              lastUnreferencedAt: now,
              observations: Math.min(Number.MAX_SAFE_INTEGER, existing.observations + 1),
            };
    }

    await this.#persist(state);
    const deletedSnapshotIds: string[] = [];
    if (this.#deletionEnabled) {
      const eligible = Object.values(state.candidates)
        .filter(
          (candidate) =>
            candidate.observations >= 2 && now - candidate.firstUnreferencedAt >= this.#graceMs,
        )
        .sort(
          (left, right) =>
            left.firstUnreferencedAt - right.firstUnreferencedAt ||
            left.snapshotId.localeCompare(right.snapshotId),
        )
        .slice(0, this.#maximumDeletesPerScan);
      for (const candidate of eligible) {
        await this.#runtime.deleteSnapshot(candidate.snapshotId);
        delete state.candidates[candidate.snapshotId];
        deletedSnapshotIds.push(candidate.snapshotId);
        await this.#persist(state);
      }
    }

    const result: ReconcileResult = Object.freeze({
      managedSnapshots: managed.length,
      referencedSnapshots: referenced.size,
      candidates: Object.keys(state.candidates).length,
      deletedSnapshotIds: Object.freeze(deletedSnapshotIds),
      deletionEnabled: this.#deletionEnabled,
    });
    state.lastScanId = request.scanId;
    state.lastResult = result;
    await this.#persist(state);
    return this.#response(request, result);
  }

  #response(
    request: SandboxManagerSnapshotGcRequest,
    result: ReconcileResult,
  ): SandboxManagerSnapshotGcResponse {
    return {
      managerProtocolVersion: 1,
      type: "workspace.snapshot_gc_reconciled",
      requestId: request.requestId,
      scanId: request.scanId,
      ...result,
      deletedSnapshotIds: [...result.deletedSnapshotIds],
    };
  }

  async #load(): Promise<CollectorState> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.#statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size < 1 ||
        metadata.size > MAXIMUM_STATE_BYTES ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new SandboxManagerError(
          "cube_snapshot_gc_state_invalid",
          "Cube snapshot garbage-collection state file is not private and bounded",
          false,
        );
      }
      return parseState(await handle.readFile());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { format: STATE_FORMAT, candidates: {} };
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #persist(state: CollectorState): Promise<void> {
    const directory = dirname(this.#statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#statePath}.tmp-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#statePath);
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
