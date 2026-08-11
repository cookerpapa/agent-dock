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
} from "@agent-dock/runtime-core/pi-session-manifest";

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

describe("Pi session manifest v3", () => {
  it("stores append-only suffixes and reconstructs byte-identical Pi JSONL", async () => {
    const firstBytes = session("one");
    const first = preparePiSessionManifest(firstBytes, "0.80.10");
    const secondBytes = session("one", "two");
    const second = preparePiSessionManifest(secondBytes, "0.80.10", {
      manifest: first.manifest,
      manifestSha256: first.manifestSha256,
    });

    expect(second.manifest.mode).toBe("append");
    expect(second.manifest.previousManifestSha256).toBe(first.manifestSha256);
    expect(second.newSegments).toHaveLength(1);

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

  it("keeps one bounded tail object instead of adding one segment per small Turn", () => {
    let previous = preparePiSessionManifest(session("one"), "0.80.10");
    for (let index = 2; index <= 120; index += 1) {
      const next = preparePiSessionManifest(
        session(...Array.from({ length: index }, (_, offset) => `turn-${String(offset)}`)),
        "0.80.10",
        { manifest: previous.manifest, manifestSha256: previous.manifestSha256 },
      );
      expect(next.manifest.segments).toHaveLength(1);
      previous = next;
    }
  });

  it("rebases non-append Pi output and keeps small append chains consolidated", () => {
    const firstBytes = session("one");
    const first = preparePiSessionManifest(firstBytes, "0.80.10");
    const rewritten = session("different");
    const rebase = preparePiSessionManifest(rewritten, "0.80.10", {
      manifest: first.manifest,
      manifestSha256: first.manifestSha256,
    });
    expect(rebase.manifest.mode).toBe("rebase");
    expect(rebase.manifest.sessionSha256).toBe(digest(rewritten));

    let previous = first;
    for (let index = 2; index <= PI_SESSION_MANIFEST_MAX_SEGMENTS + 4; index += 1) {
      const nextBytes = session(...Array.from({ length: index }, (_, offset) => String(offset)));
      const next = preparePiSessionManifest(nextBytes, "0.80.10", {
        manifest: previous.manifest,
        manifestSha256: previous.manifestSha256,
      });
      expect(next.manifest.segments).toHaveLength(1);
      previous = next;
    }
  });

  it("compresses and restores a Session larger than the former 2 MiB envelope", async () => {
    const bytes = session("x".repeat(3 * 1_024 * 1_024));
    const prepared = preparePiSessionManifest(bytes, "0.80.10");
    expect(bytes.byteLength).toBeGreaterThan(2 * 1_024 * 1_024);
    expect(prepared.manifest.segments.every((entry) => entry.encoding === "gzip")).toBe(true);
    expect(
      prepared.manifest.segments.reduce((sum, entry) => sum + entry.storedSizeBytes, 0),
    ).toBeLessThan(bytes.byteLength / 10);

    const objects = new Map(
      prepared.newSegments.map((entry) => [entry.descriptor.sha256, entry.bytes] as const),
    );
    const restored = await restorePiSessionManifest(prepared.manifest, async (descriptor) => {
      const stored = objects.get(descriptor.sha256);
      if (stored === undefined) throw new Error("missing fixture segment");
      return stored;
    });
    expect(restored.byteLength).toBe(bytes.byteLength);
    expect(digest(restored)).toBe(digest(bytes));
  });

  it("rejects malformed manifests and corrupt, missing, or reordered segments", async () => {
    const bytes = session("one", "two");
    const prepared = preparePiSessionManifest(bytes, "0.80.10");
    expect(decodePiSessionManifest(prepared.manifestBytes)).toEqual(prepared.manifest);

    const malformed = Buffer.from(
      `${JSON.stringify({ ...prepared.manifest, sessionSha256: "bad" })}\n`,
    );
    expect(() => decodePiSessionManifest(malformed)).toThrow(PiSessionManifestError);
    const obsolete = Buffer.from(
      `${JSON.stringify({ ...prepared.manifest, format: "agent-dock.pi-session-manifest.v2" })}\n`,
    );
    expect(() => decodePiSessionManifest(obsolete)).toThrow("format is unsupported");

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
