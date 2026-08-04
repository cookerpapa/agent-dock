import { describe, expect, it, vi } from "vitest";
import { RecoverableOperationLedger } from "../src/recoverable-operation-ledger.ts";

describe("RecoverableOperationLedger", () => {
  it("reattaches duplicate transport requests to one execution", async () => {
    let resolveExecution!: (value: string) => void;
    const execution = new Promise<string>((resolve) => {
      resolveExecution = resolve;
    });
    const start = vi.fn(() => execution);
    const ledger = new RecoverableOperationLedger<{ command: string }, string>();
    const first = ledger.attach("operation-1", { command: "build" }, start);
    const reattached = ledger.attach("operation-1", { command: "build" }, start);

    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    resolveExecution("ordered-result");
    await expect(Promise.all([first, reattached])).resolves.toEqual([
      "ordered-result",
      "ordered-result",
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    ledger.close();
  });

  it("rejects an operation ID whose request changed", async () => {
    const ledger = new RecoverableOperationLedger<{ command: string }, string>();
    await expect(
      ledger.attach("operation-2", { command: "first" }, async () => "done"),
    ).resolves.toBe("done");
    await expect(
      ledger.attach("operation-2", { command: "different" }, async () => "wrong"),
    ).rejects.toThrow("changed its request");
    ledger.close();
  });
});
