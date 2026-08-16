import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const LEDGER_FILE = "boot-ledger.json";
const MAX_LEDGER_BYTES = 128 * 1_024;
const MAX_HISTORY = 64;

export type SupervisorHostBootIdentity = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
};

export type SupervisorBootLedgerGeneration = {
  bootId: string;
  sandboxId: string;
  status: "active" | "exited" | "stopped";
  startedAt: string;
  endedAt: string | null;
};

type LedgerState = {
  supervisorId: string;
  current: SupervisorBootLedgerGeneration | null;
  history: SupervisorBootLedgerGeneration[];
};

type LedgerEnvelope = {
  format: "pi-cloud.supervisor-boot-ledger.v1";
  sha256: string;
  state: LedgerState;
};

export type SupervisorBootLedgerOptions = {
  rootDirectory: string;
  supervisorId: string;
  clock?: () => Date;
  idGenerator?: () => string;
};

export class SupervisorBootLedgerError extends Error {
  readonly code: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "SupervisorBootLedgerError";
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalBytes(state: LedgerState): Buffer {
  const stateJson = JSON.stringify(state);
  const envelope: LedgerEnvelope = {
    format: "pi-cloud.supervisor-boot-ledger.v1",
    sha256: sha256(stateJson),
    state,
  };
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

function boundedIdentity(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SupervisorBootLedgerError("boot_ledger_invalid", `${name} is invalid`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new SupervisorBootLedgerError("boot_ledger_invalid", `${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new SupervisorBootLedgerError("boot_ledger_invalid", `${name} is invalid`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new SupervisorBootLedgerError("boot_ledger_invalid", `${name} is invalid`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Supervisor boot ledger clock must return a valid Date");
  }
  return value;
}

function generation(value: unknown): SupervisorBootLedgerGeneration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupervisorBootLedgerError("boot_ledger_invalid", "Boot generation is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "bootId,endedAt,sandboxId,startedAt,status" ||
    (record.status !== "active" && record.status !== "exited" && record.status !== "stopped")
  ) {
    throw new SupervisorBootLedgerError("boot_ledger_invalid", "Boot generation is invalid");
  }
  const startedAt = timestamp(record.startedAt, "Boot start time");
  const endedAt = record.endedAt === null ? null : timestamp(record.endedAt, "Boot end time");
  if ((record.status === "active") !== (endedAt === null)) {
    throw new SupervisorBootLedgerError(
      "boot_ledger_invalid",
      "Boot generation state is inconsistent",
    );
  }
  return {
    bootId: uuid(record.bootId, "Boot ID"),
    sandboxId: uuid(record.sandboxId, "Sandbox ID"),
    status: record.status,
    startedAt,
    endedAt,
  };
}

function parseLedger(bytes: Buffer): LedgerState {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new SupervisorBootLedgerError("boot_ledger_corrupt", "Boot ledger is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupervisorBootLedgerError("boot_ledger_corrupt", "Boot ledger shape is invalid");
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join(",") !== "format,sha256,state" ||
    envelope.format !== "pi-cloud.supervisor-boot-ledger.v1" ||
    typeof envelope.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(envelope.sha256) ||
    typeof envelope.state !== "object" ||
    envelope.state === null ||
    Array.isArray(envelope.state)
  ) {
    throw new SupervisorBootLedgerError("boot_ledger_corrupt", "Boot ledger shape is invalid");
  }
  const rawState = envelope.state as Record<string, unknown>;
  if (
    Object.keys(rawState).sort().join(",") !== "current,history,supervisorId" ||
    !Array.isArray(rawState.history) ||
    rawState.history.length > MAX_HISTORY
  ) {
    throw new SupervisorBootLedgerError("boot_ledger_corrupt", "Boot ledger state is invalid");
  }
  const state: LedgerState = {
    supervisorId: boundedIdentity(rawState.supervisorId, "Supervisor ID"),
    current: rawState.current === null ? null : generation(rawState.current),
    history: rawState.history.map(generation),
  };
  const identities = [state.current, ...state.history]
    .filter((item): item is SupervisorBootLedgerGeneration => item !== null)
    .map((item) => `${item.bootId}:${item.sandboxId}`);
  if (new Set(identities).size !== identities.length) {
    throw new SupervisorBootLedgerError(
      "boot_ledger_corrupt",
      "Boot ledger contains duplicate generations",
    );
  }
  const expected = canonicalBytes(state);
  if (envelope.sha256 !== sha256(JSON.stringify(state)) || !expected.equals(bytes)) {
    throw new SupervisorBootLedgerError(
      "boot_ledger_corrupt",
      "Boot ledger failed integrity validation",
    );
  }
  return state;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new SupervisorBootLedgerError(
      "boot_ledger_permissions",
      "Boot ledger directory is not private",
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class SupervisorBootLedger {
  readonly #rootDirectory: string;
  readonly #path: string;
  readonly #supervisorId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  #operations: Promise<void> = Promise.resolve();

  constructor(options: SupervisorBootLedgerOptions) {
    if (options.rootDirectory.trim().length === 0) {
      throw new TypeError("rootDirectory must not be empty");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#path = resolve(this.#rootDirectory, LEDGER_FILE);
    this.#supervisorId = boundedIdentity(options.supervisorId, "Supervisor ID");
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  beginBoot(identity: SupervisorHostBootIdentity): Promise<SupervisorBootLedgerGeneration> {
    return this.#serialize(async () => {
      this.#assertIdentity(identity);
      const now = validDate(this.#clock).toISOString();
      const state = await this.#load();
      const all = [state.current, ...state.history].filter(
        (item): item is SupervisorBootLedgerGeneration => item !== null,
      );
      if (
        all.some((item) => item.bootId === identity.bootId || item.sandboxId === identity.sandboxId)
      ) {
        throw new SupervisorBootLedgerError(
          "boot_generation_reused",
          "Boot or sandbox identity was already used",
        );
      }
      const history = [...state.history];
      if (state.current !== null) {
        history.push(
          state.current.status === "active"
            ? { ...state.current, status: "exited", endedAt: now }
            : state.current,
        );
      }
      const current: SupervisorBootLedgerGeneration = {
        bootId: identity.bootId,
        sandboxId: identity.sandboxId,
        status: "active",
        startedAt: now,
        endedAt: null,
      };
      await this.#store({
        supervisorId: this.#supervisorId,
        current,
        history: history.slice(-MAX_HISTORY),
      });
      return current;
    });
  }

  markStopped(identity: SupervisorHostBootIdentity): Promise<void> {
    return this.#serialize(async () => {
      this.#assertIdentity(identity);
      const state = await this.#load();
      if (
        state.current?.bootId === identity.bootId &&
        state.current.sandboxId === identity.sandboxId
      ) {
        if (state.current.status !== "active") return;
        const now = validDate(this.#clock).toISOString();
        await this.#store({
          ...state,
          current: { ...state.current, status: "stopped", endedAt: now },
        });
        return;
      }
      const known = state.history.find(
        (item) => item.bootId === identity.bootId && item.sandboxId === identity.sandboxId,
      );
      if (known !== undefined) return;
      throw new SupervisorBootLedgerError(
        "boot_generation_unknown",
        "Boot generation is not known to this host",
      );
    });
  }

  async current(): Promise<SupervisorBootLedgerGeneration | null> {
    await this.#operations;
    const state = await this.#load();
    return state.current === null ? null : { ...state.current };
  }

  async generationForSandbox(sandboxId: string): Promise<SupervisorBootLedgerGeneration | null> {
    uuid(sandboxId, "Sandbox ID");
    await this.#operations;
    const state = await this.#load();
    const value = [state.current, ...state.history].find(
      (item): item is SupervisorBootLedgerGeneration =>
        item !== null && item.sandboxId === sandboxId,
    );
    return value === undefined ? null : { ...value };
  }

  async #load(): Promise<LedgerState> {
    await privateDirectory(this.#rootDirectory);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size < 1 ||
        metadata.size > MAX_LEDGER_BYTES
      ) {
        throw new SupervisorBootLedgerError(
          "boot_ledger_permissions",
          "Boot ledger file is not a private regular file",
        );
      }
      const bytes = await handle.readFile();
      const state = parseLedger(bytes);
      if (state.supervisorId !== this.#supervisorId) {
        throw new SupervisorBootLedgerError(
          "boot_ledger_identity_mismatch",
          "Boot ledger belongs to another Supervisor",
        );
      }
      return state;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { supervisorId: this.#supervisorId, current: null, history: [] };
      }
      if (error instanceof SupervisorBootLedgerError) throw error;
      throw new SupervisorBootLedgerError(
        "boot_ledger_unavailable",
        "Boot ledger could not be read safely",
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #store(state: LedgerState): Promise<void> {
    await privateDirectory(this.#rootDirectory);
    const temporary = resolve(this.#rootDirectory, `.tmp-${this.#idGenerator()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(canonicalBytes(state));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
      await syncDirectory(this.#rootDirectory);
    } catch (error: unknown) {
      if (error instanceof SupervisorBootLedgerError) throw error;
      throw new SupervisorBootLedgerError(
        "boot_ledger_unavailable",
        "Boot ledger could not be stored safely",
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #assertIdentity(identity: SupervisorHostBootIdentity): void {
    if (boundedIdentity(identity.supervisorId, "Supervisor ID") !== this.#supervisorId) {
      throw new SupervisorBootLedgerError(
        "boot_ledger_identity_mismatch",
        "Boot identity belongs to another Supervisor",
      );
    }
    uuid(identity.bootId, "Boot ID");
    uuid(identity.sandboxId, "Sandbox ID");
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
