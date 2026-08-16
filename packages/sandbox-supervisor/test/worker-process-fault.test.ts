import type { EventPublishMessage } from "@pi-cloud/protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WalEventSpoolStore } from "../src/wal-event-spool.ts";

const children = new Set<ChildProcessWithoutNullStreams>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function waitForDurableAppend(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Worker fixture did not append in time")),
      5_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes('"status":"durable"')) return;
      clearTimeout(timeout);
      resolvePromise();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Worker fixture exited early: ${String(code)}/${String(signal)} ${output}`));
    });
  });
}

describe("Worker process fault boundary", () => {
  it("recovers a browser-visible event whose producing Worker was SIGKILLed after WAL fsync", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "pi-cloud-worker-process-fault-"));
    roots.push(root);
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(import.meta.dirname, "fixtures/event-wal-process.mjs"),
        root,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    children.add(child);
    await waitForDurableAppend(child);
    child.kill("SIGKILL");
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    children.delete(child);

    const replayed: EventPublishMessage[] = [];
    const result = await new WalEventSpoolStore({ rootDirectory: root }).redeliverPending(
      (message) => {
        replayed.push(message);
        return {
          protocolVersion: 1,
          messageId: globalThis.crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          type: "event.ack",
          payload: {
            sessionId: message.payload.event.sessionId,
            leaseId: message.payload.leaseId,
            fencingToken: message.payload.fencingToken,
            acknowledgedThroughSeq: message.payload.event.seq,
          },
        };
      },
    );

    expect(result).toMatchObject({ replayedSpools: 1, replayedEvents: 1 });
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.payload.event).toMatchObject({
      seq: 1,
      type: "assistant.text.delta",
      payload: { text: "durable-before-worker-sigkill" },
    });
  });
});
