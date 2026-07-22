import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubWorkspaceImportProtocolError,
  parseGitHubWorkspaceImportOutput,
  parseGitHubWorkspaceImportRequest,
} from "../src/index.ts";

const IMPORT_ID = "10000000-0000-4000-8000-000000000001";
const COMMIT_SHA = "a".repeat(40);
const EGRESS_PROXY = {
  host: "10.43.0.10",
  port: 3128,
  capability: `adpc1_${"a".repeat(128)}.${"b".repeat(86)}`,
  publicKeyFingerprint: "c".repeat(64),
} as const;

function blob(value: string) {
  const bytes = Buffer.from(value);
  return {
    encoding: "base64" as const,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    data: bytes.toString("base64"),
  };
}

describe("GitHub workspace importer protocol", () => {
  it("accepts a closed exact-commit request and a bounded snapshot result", () => {
    expect(
      parseGitHubWorkspaceImportRequest({
        workspaceImportProtocolVersion: 1,
        type: "workspace.import",
        importId: IMPORT_ID,
        source: {
          kind: "github_public",
          repository: "octocat/hello-world",
          commitSha: COMMIT_SHA,
        },
        egressProxy: EGRESS_PROXY,
      }),
    ).toMatchObject({ source: { repository: "octocat/hello-world", commitSha: COMMIT_SHA } });

    expect(
      parseGitHubWorkspaceImportOutput({
        workspaceImportProtocolVersion: 1,
        type: "workspace.import.result",
        importId: IMPORT_ID,
        snapshot: blob('{"format":"agent-dock.workspace-manifest.v1","files":[]}\n'),
      }),
    ).toMatchObject({ type: "workspace.import.result", importId: IMPORT_ID });
  });

  it("accepts only safe failure details", () => {
    expect(
      parseGitHubWorkspaceImportOutput({
        workspaceImportProtocolVersion: 1,
        type: "workspace.import.failed",
        importId: IMPORT_ID,
        code: "repository_git_failed",
        message: "Public GitHub repository import failed",
        retryable: true,
      }),
    ).toMatchObject({ code: "repository_git_failed", retryable: true });
    expect(() =>
      parseGitHubWorkspaceImportOutput({
        workspaceImportProtocolVersion: 1,
        type: "workspace.import.failed",
        importId: IMPORT_ID,
        code: "BAD-CODE",
        message: "unsafe",
        retryable: false,
      }),
    ).toThrow(GitHubWorkspaceImportProtocolError);
  });

  it("rejects URLs, symbolic refs, credentials, and extra fields", () => {
    for (const source of [
      {
        kind: "github_public",
        repository: "https://github.com/octocat/hello-world",
        commitSha: COMMIT_SHA,
      },
      { kind: "github_public", repository: "octocat/hello-world", commitSha: "main" },
      {
        kind: "github_public",
        repository: "octocat/hello-world",
        commitSha: COMMIT_SHA,
        token: "secret",
      },
    ]) {
      expect(() =>
        parseGitHubWorkspaceImportRequest({
          workspaceImportProtocolVersion: 1,
          type: "workspace.import",
          importId: IMPORT_ID,
          source,
          egressProxy: EGRESS_PROXY,
        }),
      ).toThrow(GitHubWorkspaceImportProtocolError);
    }
  });
});
