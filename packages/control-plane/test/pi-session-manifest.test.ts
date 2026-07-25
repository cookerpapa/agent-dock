import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PI_SESSION_MANIFEST_MAX_SEGMENTS,
  PiSessionManifestError,
  decodePiSessionManifest,
  preparePiSessionManifest,
  restorePiSessionManifest,
  type PiSessionManifest,
  type PiSessionSegment,
} from "../src/pi-session-manifest.ts";

function session(...labels: string[]): Uint8Array {
  return Buffer.from(
    [
      JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/workspace" }),
      ...labels.map((label, index) =>
        JSON.stringify({
          type: "message",
          id: `entry-${String(index + 1)}`,
          parentId: index === 0 ? null : `entry-${String(index)}`,
          message: { role: "assistant", content: [{ type: "text", text: label }] },
        }),
      ),
      "",
    ].join("\n"),
  );
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Pi session manifest v2", () => {
  it("stores append-only suffixes and reconstructs byte-identical Pi JSONL", async () => {
    const firstBytes = session("one");
    const first = preparePiSessionManifest(firstBytes, "0.80.10");
    const secondBytes = session("one", "two");
    const second = preparePiSessionManifest(secondBytes, "0.80.10", {
      bytes: firstBytes,
      manifest: first.manifest,
      manifestSha256: first.manifestSha256,
    });

    expect(second.manifest.mode).toBe("append");
    expect(second.manifest.previousManifestSha256).toBe(first.manifestSha256);
    expect(second.newSegments).toHaveLength(1);
    expect(second.manifest.segments.slice(0, first.manifest.segments.length)).toEqual(
      first.manifest.segments,
    );

    const objects = new Map<string, Uint8Array>();
    for (const segment of [...first.newSegments, ...second.newSegments]) {
      objects.set(segment.descriptor.sha256, segment.bytes);
    }
    await expect(
      restorePiSessionManifest(second.manifest, async (descriptor) => {
        const bytes = objects.get(descriptor.sha256);
        if (bytes === undefined) throw new Error("missing fixture segment");
        return bytes;
      }),
    ).resolves.toEqual(secondBytes);
  });

  it("rebases non-append Pi output and consolidates an excessive segment chain", () => {
    const firstBytes = session("one");
    const first = preparePiSessionManifest(firstBytes, "0.80.10");
    const rewritten = session("different");
    const rebase = preparePiSessionManifest(rewritten, "0.80.10", {
      bytes: firstBytes,
      manifest: first.manifest,
      manifestSha256: first.manifestSha256,
    });
    expect(rebase.manifest.mode).toBe("rebase");
    expect(rebase.manifest.sessionSha256).toBe(digest(rewritten));

    let previousBytes = firstBytes;
    let previous = first;
    let consolidated = false;
    for (let index = 2; index <= PI_SESSION_MANIFEST_MAX_SEGMENTS + 4; index += 1) {
      const nextBytes = session(...Array.from({ length: index }, (_, offset) => String(offset)));
      const next = preparePiSessionManifest(nextBytes, "0.80.10", {
        bytes: previousBytes,
        manifest: previous.manifest,
        manifestSha256: previous.manifestSha256,
      });
      if (next.manifest.mode === "rebase") consolidated = true;
      expect(next.manifest.segments.length).toBeLessThanOrEqual(PI_SESSION_MANIFEST_MAX_SEGMENTS);
      previousBytes = nextBytes;
      previous = next;
    }
    expect(consolidated).toBe(true);
  });

  it("rejects malformed manifests and corrupt, missing, or reordered segments", async () => {
    const bytes = session("one", "two");
    const prepared = preparePiSessionManifest(bytes, "0.80.10");
    expect(decodePiSessionManifest(prepared.manifestBytes)).toEqual(prepared.manifest);

    const malformed = Buffer.from(
      `${JSON.stringify({ ...prepared.manifest, sessionSha256: "bad" })}\n`,
    );
    expect(() => decodePiSessionManifest(malformed)).toThrow(PiSessionManifestError);

    const objects = new Map(
      prepared.newSegments.map((entry) => [entry.descriptor.sha256, entry] as const),
    );
    await expect(
      restorePiSessionManifest(prepared.manifest, async (descriptor) => {
        const entry = objects.get(descriptor.sha256);
        if (entry === undefined) throw new Error("missing");
        return Buffer.concat([Buffer.from(entry.bytes), Buffer.from("corrupt\n")]);
      }),
    ).rejects.toThrow("integrity");

    if (prepared.manifest.segments.length > 1) {
      const reversed: PiSessionManifest = {
        ...prepared.manifest,
        segments: [...prepared.manifest.segments].reverse(),
      };
      await expect(
        restorePiSessionManifest(reversed, async (descriptor) => {
          const entry: PiSessionSegment | undefined = objects.get(descriptor.sha256);
          if (entry === undefined) throw new Error("missing");
          return entry.bytes;
        }),
      ).rejects.toThrow("Reconstructed");
    }
  });
});
