import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SupervisorBootLedger, SupervisorBootLedgerError } from "../src/index.ts";

const roots: string[] = [];

function identity(supervisorId = "supervisor-ledger-test") {
  return {
    supervisorId,
    bootId: globalThis.crypto.randomUUID(),
    sandboxId: globalThis.crypto.randomUUID(),
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-cloud-boot-ledger-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SupervisorBootLedger", () => {
  it("records a fresh boot and marks the previous process generation exited", async () => {
    const directory = await root();
    const times = [new Date("2026-07-19T10:00:00.000Z"), new Date("2026-07-19T10:01:00.000Z")];
    const ledger = new SupervisorBootLedger({
      rootDirectory: directory,
      supervisorId: "supervisor-ledger-test",
      clock: () => times.shift()!,
    });
    const first = identity();
    const second = identity();
    await ledger.beginBoot(first);
    await ledger.beginBoot(second);
    await expect(ledger.current()).resolves.toMatchObject({
      bootId: second.bootId,
      sandboxId: second.sandboxId,
      status: "active",
    });
    const bytes = JSON.parse(await readFile(join(directory, "boot-ledger.json"), "utf8")) as {
      state: { history: Array<{ bootId: string; status: string; endedAt: string }> };
    };
    expect(bytes.state.history).toContainEqual(
      expect.objectContaining({
        bootId: first.bootId,
        status: "exited",
        endedAt: "2026-07-19T10:01:00.000Z",
      }),
    );
  });

  it("permanently stops a known generation and rejects unknown or reused identity", async () => {
    const directory = await root();
    const ledger = new SupervisorBootLedger({
      rootDirectory: directory,
      supervisorId: "supervisor-ledger-test",
    });
    const current = identity();
    await ledger.beginBoot(current);
    await ledger.markStopped(current);
    await ledger.markStopped(current);
    await expect(ledger.current()).resolves.toMatchObject({ status: "stopped" });
    await expect(ledger.markStopped(identity())).rejects.toMatchObject({
      code: "boot_generation_unknown",
    });
    await expect(ledger.beginBoot(current)).rejects.toMatchObject({
      code: "boot_generation_reused",
    });

    const next = identity();
    await ledger.beginBoot(next);
    await expect(ledger.generationForSandbox(current.sandboxId)).resolves.toMatchObject({
      bootId: current.bootId,
      status: "stopped",
    });
    await expect(ledger.generationForSandbox(next.sandboxId)).resolves.toMatchObject({
      bootId: next.bootId,
      status: "active",
    });
    await expect(ledger.generationForSandbox(globalThis.crypto.randomUUID())).resolves.toBeNull();
  });

  it("fails closed for a world-readable or corrupted ledger", async () => {
    const directory = await root();
    const ledger = new SupervisorBootLedger({
      rootDirectory: directory,
      supervisorId: "supervisor-ledger-test",
    });
    await ledger.beginBoot(identity());
    const path = join(directory, "boot-ledger.json");
    await chmod(path, 0o644);
    await expect(ledger.current()).rejects.toBeInstanceOf(SupervisorBootLedgerError);
    await chmod(path, 0o600);
    const bytes = await readFile(path);
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! === 0x7d ? 0x7c : 0x7d;
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(ledger.current()).rejects.toMatchObject({ code: "boot_ledger_corrupt" });
  });
});
