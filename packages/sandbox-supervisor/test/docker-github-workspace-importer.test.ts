import { describe, expect, it } from "vitest";
import {
  buildDockerGitHubWorkspaceImportArguments,
  DockerGitHubWorkspaceImporter,
  isMissingDockerObjectDiagnostic,
} from "../src/index.ts";

const IMPORT_ID = "10000000-0000-4000-8000-000000000001";

describe("hardened GitHub workspace importer container", () => {
  it("uses a dedicated network without host mounts, secrets, or source coordinates in argv", () => {
    const args = buildDockerGitHubWorkspaceImportArguments(
      "agent-dock/pi-workspace:production",
      "agent-dock-production_repository-egress",
      "agent-dock-import-10000000-0000-4000-8000-000000000001",
      IMPORT_ID,
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--rm",
        "--interactive",
        "--read-only",
        "--network",
        "agent-dock-production_repository-egress",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "96",
        "--entrypoint",
        "node",
      ]),
    );
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--mount");
    expect(args).not.toContain("--env");
    expect(args.join(" ")).not.toContain("github.com");
    expect(args.join(" ")).not.toContain("octocat");
  });

  it("rejects the networkless lane and malformed importer identities", () => {
    expect(() =>
      buildDockerGitHubWorkspaceImportArguments(
        "agent-dock/pi-workspace:production",
        "none",
        "agent-dock-import-safe",
        IMPORT_ID,
      ),
    ).toThrow("network is invalid");
    expect(() =>
      buildDockerGitHubWorkspaceImportArguments(
        "agent-dock/pi-workspace:production",
        "repository-egress",
        "agent-dock-import-safe",
        "not-a-uuid",
      ),
    ).toThrow("import ID is invalid");
  });

  it("distinguishes confirmed absence from an unverified Docker failure", () => {
    expect(isMissingDockerObjectDiagnostic("Error: No such object: importer-1\n")).toBe(true);
    expect(isMissingDockerObjectDiagnostic("\nerror: no such object: importer-1\n")).toBe(true);
    expect(
      isMissingDockerObjectDiagnostic(
        "Error response from daemon: No such container: importer-1\n",
      ),
    ).toBe(true);
    expect(
      isMissingDockerObjectDiagnostic("Cannot connect to the Docker daemon at unix:///socket"),
    ).toBe(false);
  });

  it("does not start Docker for an already-cancelled import", async () => {
    const controller = new AbortController();
    controller.abort();
    const importer = new DockerGitHubWorkspaceImporter({
      image: "agent-dock/pi-workspace:production",
      network: "repository-egress",
      dockerCommand: "must-not-run",
    });
    await expect(
      importer.import(
        {
          kind: "github_public",
          repository: "octocat/hello-world",
          commitSha: "a".repeat(40),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "repository_import_cancelled", retryable: true });
  });
});
