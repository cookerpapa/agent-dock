import { describe, expect, it } from "vitest";
import { parseCloudToolCapabilitySnapshot } from "../src/index.ts";

describe("Cloud Tool capability snapshots", () => {
  it("allows a Tool-free Run without granting a fake filesystem capability", () => {
    expect(parseCloudToolCapabilitySnapshot([])).toEqual([]);
  });

  it("canonicalizes an accepted subset without widening it", () => {
    expect(parseCloudToolCapabilitySnapshot(["bash", "read"])).toEqual(["read", "bash"]);
  });

  it.each([["read", "read"], ["read", "mcp.admin"], "read"])(
    "rejects an invalid capability snapshot %#",
    (candidate) => {
      expect(() => parseCloudToolCapabilitySnapshot(candidate)).toThrow(
        "Cloud Tool capability snapshot is invalid",
      );
    },
  );
});
