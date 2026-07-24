import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  canonicalEnvironmentRecipeJson,
  isExpectedDefaultToolchain,
  parseEnvironmentRuntimeSnapshot,
  parseEnvironmentValidationReport,
} from "../src/index.ts";

const snapshot = {
  environmentVersionId: "10000000-0000-4000-8000-000000000001",
  versionNumber: 1,
  profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  imageRevision: "sha-0123456789abcdef",
  specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} as const;

const tools = [
  { name: "node", version: "v24.12.0" },
  { name: "java", version: 'openjdk version "17.0.19" 2026-04-21' },
  { name: "python", version: "Python 3.11.2" },
  { name: "git", version: "git version 2.39.5" },
] as const;

describe("versioned project environment protocol", () => {
  it("accepts only the immutable operator profile snapshot", () => {
    expect(parseEnvironmentRuntimeSnapshot(snapshot)).toEqual(snapshot);
    expect(() =>
      parseEnvironmentRuntimeSnapshot({ ...snapshot, image: "user/image:latest" }),
    ).toThrow();
    expect(() => parseEnvironmentRuntimeSnapshot({ ...snapshot, profileVersion: "2" })).toThrow();
  });

  it("validates concrete gVisor and toolchain evidence", () => {
    const report = parseEnvironmentValidationReport({
      profileKey: snapshot.profileKey,
      profileVersion: snapshot.profileVersion,
      imageRevision: snapshot.imageRevision,
      specSha256: snapshot.specSha256,
      recipeSha256: snapshot.recipeSha256,
      isolationBoundary: "gvisor",
      runtime: "runsc",
      networkMode: "deny_all",
      runAsUser: "1000:1000",
      readOnlyRootFilesystem: true,
      tools,
      recipeCommands: [],
    });
    expect(isExpectedDefaultToolchain(report)).toBe(true);
    expect(
      isExpectedDefaultToolchain({
        ...report,
        tools: tools.map((tool) =>
          tool.name === "python" ? { ...tool, version: "Python 3.12.3" } : tool,
        ),
      }),
    ).toBe(false);
  });

  it("accepts only the explicit CubeSandbox microVM evidence pair", () => {
    const report = parseEnvironmentValidationReport({
      profileKey: snapshot.profileKey,
      profileVersion: snapshot.profileVersion,
      imageRevision: snapshot.imageRevision,
      specSha256: snapshot.specSha256,
      recipeSha256: snapshot.recipeSha256,
      isolationBoundary: "microvm",
      runtime: "cubesandbox-kvm",
      networkMode: "deny_all",
      runAsUser: "1000:1000",
      readOnlyRootFilesystem: false,
      tools,
      recipeCommands: [],
    });
    expect(report.runtime).toBe("cubesandbox-kvm");
    expect(() =>
      parseEnvironmentValidationReport({
        ...report,
        runtime: "runsc",
      }),
    ).toThrow();
    expect(() =>
      parseEnvironmentValidationReport({
        ...report,
        readOnlyRootFilesystem: true,
      }),
    ).toThrow();
  });

  it("canonicalizes recipes and rejects ambiguous command identities and paths", () => {
    expect(canonicalEnvironmentRecipeJson(DEFAULT_PROJECT_ENVIRONMENT_RECIPE)).toBe(
      JSON.stringify(DEFAULT_PROJECT_ENVIRONMENT_RECIPE),
    );
    expect(() =>
      parseEnvironmentRuntimeSnapshot({
        ...snapshot,
        recipe: {
          schemaVersion: 1,
          setupCommands: [
            {
              id: "git-worktree",
              command: "true",
              cwd: ".",
              timeoutMs: 1_000,
              network: "none",
            },
          ],
          verificationCommands: DEFAULT_PROJECT_ENVIRONMENT_RECIPE.verificationCommands,
        },
      }),
    ).toThrow(/repeated/);
    expect(() =>
      parseEnvironmentRuntimeSnapshot({
        ...snapshot,
        recipe: {
          ...DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          verificationCommands: [
            {
              ...DEFAULT_PROJECT_ENVIRONMENT_RECIPE.verificationCommands[0],
              cwd: "src/../escape",
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      canonicalEnvironmentRecipeJson({
        schemaVersion: 1,
        setupCommands: ["one", "two", "three"].map((id) => ({
          id,
          command: "true",
          cwd: ".",
          timeoutMs: 300_000,
          network: "none",
        })),
        verificationCommands: DEFAULT_PROJECT_ENVIRONMENT_RECIPE.verificationCommands,
      }),
    ).toThrow(/ten minutes/);
  });

  it("binds dependency commands to a normalized exact-host policy", () => {
    const recipe = {
      schemaVersion: 1,
      dependencyHosts: ["registry.npmjs.org", "files.pythonhosted.org"],
      setupCommands: [
        {
          id: "install",
          command: "python3 -m pip install -r requirements.txt",
          cwd: ".",
          timeoutMs: 120_000,
          network: "dependency",
        },
      ],
      verificationCommands: DEFAULT_PROJECT_ENVIRONMENT_RECIPE.verificationCommands,
    } as const;
    expect(JSON.parse(canonicalEnvironmentRecipeJson(recipe))).toMatchObject({
      dependencyHosts: ["files.pythonhosted.org", "registry.npmjs.org"],
    });
    expect(() =>
      canonicalEnvironmentRecipeJson({
        ...recipe,
        dependencyHosts: undefined,
      }),
    ).toThrow(/dependency hosts/);
    expect(() =>
      canonicalEnvironmentRecipeJson({
        ...DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        dependencyHosts: ["registry.npmjs.org"],
      }),
    ).toThrow(/dependency hosts/);
    expect(() =>
      canonicalEnvironmentRecipeJson({
        ...recipe,
        dependencyHosts: ["*.npmjs.org"],
      }),
    ).toThrow();
  });
});
