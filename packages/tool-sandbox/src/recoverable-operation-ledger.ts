import { createHash } from "node:crypto";

export type RecoverableOperationLedgerOptions = Readonly<{
  retentionMs?: number;
  maximumEntries?: number;
}>;

type LedgerEntry<TResult> = {
  requestSha256: string;
  result: Promise<TResult>;
  retentionTimer?: NodeJS.Timeout;
};

/**
 * Keeps execution identity independent from one transport attachment. Equal
 * operation IDs attach to one promise; conflicting requests fail closed.
 */
export class RecoverableOperationLedger<TRequest, TResult> {
  readonly #retentionMs: number;
  readonly #maximumEntries: number;
  readonly #entries = new Map<string, LedgerEntry<TResult>>();

  constructor(options: RecoverableOperationLedgerOptions = {}) {
    this.#retentionMs = options.retentionMs ?? 30_000;
    this.#maximumEntries = options.maximumEntries ?? 1_024;
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < 1) {
      throw new TypeError("Operation retention must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maximumEntries) || this.#maximumEntries < 1) {
      throw new TypeError("Operation ledger capacity must be a positive safe integer");
    }
  }

  attach(operationId: string, request: TRequest, start: () => Promise<TResult>): Promise<TResult> {
    const requestSha256 = createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
    const existing = this.#entries.get(operationId);
    if (existing !== undefined) {
      if (existing.requestSha256 !== requestSha256) {
        return Promise.reject(new Error("Tool operation ID changed its request"));
      }
      return existing.result;
    }
    if (this.#entries.size >= this.#maximumEntries) {
      return Promise.reject(new Error("Tool operation recovery ledger is full"));
    }
    const result = Promise.resolve().then(start);
    const entry: LedgerEntry<TResult> = { requestSha256, result };
    this.#entries.set(operationId, entry);
    const retain = (): void => {
      const timer = setTimeout(() => {
        if (this.#entries.get(operationId) === entry) this.#entries.delete(operationId);
      }, this.#retentionMs);
      timer.unref();
      entry.retentionTimer = timer;
    };
    void result.then(retain, retain);
    return result;
  }

  close(): void {
    for (const entry of this.#entries.values()) {
      if (entry.retentionTimer !== undefined) clearTimeout(entry.retentionTimer);
    }
    this.#entries.clear();
  }
}
