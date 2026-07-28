import { describe, expect, it } from "vitest";
import {
  canPreviewWorkspaceFile,
  directoryEntries,
  MAXIMUM_WORKSPACE_PREVIEW_BYTES,
  visibleDirectoryEntries,
} from "../src/WorkspaceInspector.tsx";

const files = [
  {
    path: "src/components/Button.tsx",
    sizeBytes: 120,
    sha256: "a".repeat(64),
    executable: false,
  },
  {
    path: "src/index.ts",
    sizeBytes: 80,
    sha256: "b".repeat(64),
    executable: false,
  },
  {
    path: "README.md",
    sizeBytes: 40,
    sha256: "c".repeat(64),
    executable: false,
  },
];

describe("Workspace directory tree", () => {
  it("orders entries as a directory tree instead of a flat parent grouping", () => {
    expect(directoryEntries(files).map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "directory:src",
      "directory:src/components",
      "file:src/components/Button.tsx",
      "file:src/index.ts",
      "file:README.md",
    ]);
  });

  it("reveals descendants only when every parent directory is expanded", () => {
    const entries = directoryEntries(files);
    expect(visibleDirectoryEntries(entries, new Set()).map((entry) => entry.path)).toEqual([
      "src",
      "README.md",
    ]);
    expect(visibleDirectoryEntries(entries, new Set(["src"])).map((entry) => entry.path)).toEqual([
      "src",
      "src/components",
      "src/index.ts",
      "README.md",
    ]);
    expect(
      visibleDirectoryEntries(entries, new Set(["src", "src/components"])).map(
        (entry) => entry.path,
      ),
    ).toEqual(["src", "src/components", "src/components/Button.tsx", "src/index.ts", "README.md"]);
  });

  it("keeps oversized files outside the bounded browser materialization path", () => {
    const previewFile = {
      path: "src/components/Button.tsx",
      sizeBytes: MAXIMUM_WORKSPACE_PREVIEW_BYTES,
      sha256: "d".repeat(64),
      executable: false,
    };
    expect(
      canPreviewWorkspaceFile({
        ...previewFile,
      }),
    ).toBe(true);
    expect(
      canPreviewWorkspaceFile({
        ...previewFile,
        sizeBytes: MAXIMUM_WORKSPACE_PREVIEW_BYTES + 1,
      }),
    ).toBe(false);
  });
});
