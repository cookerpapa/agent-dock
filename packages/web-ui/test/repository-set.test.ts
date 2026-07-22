import { describe, expect, it } from "vitest";
import { parseRepositorySetManifest, repositorySetLabel } from "../src/repository-set.ts";

describe("repository-set workspace input", () => {
  it("normalizes an exact multi-repository manifest for the control plane", () => {
    const source = parseRepositorySetManifest(
      JSON.stringify([
        {
          root: "web",
          kind: "github_public",
          repository: "octocat/frontend",
          commitSha: "a".repeat(40),
        },
        {
          root: "api",
          kind: "github_app",
          installationId: 7,
          repositoryId: 42,
          commitSha: "b".repeat(40),
        },
      ]),
    );
    expect(source.repositories).toHaveLength(2);
    expect(repositorySetLabel(source)).toBe("2 repositories · web, api");
  });

  it("rejects invalid JSON, duplicate roots, and mutable refs", () => {
    expect(() => parseRepositorySetManifest("not-json")).toThrow(/valid JSON/);
    expect(() =>
      parseRepositorySetManifest(
        JSON.stringify([
          {
            root: "service",
            kind: "github_public",
            repository: "octocat/one",
            commitSha: "a".repeat(40),
          },
          {
            root: "service",
            kind: "github_public",
            repository: "octocat/two",
            commitSha: "main",
          },
        ]),
      ),
    ).toThrow();
  });
});
