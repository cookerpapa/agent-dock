import { describe, expect, it } from "vitest";
import {
  canonicalEnvironmentRecipeJson,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type EnvironmentRecipe,
  type EnvironmentRuntimeSnapshot,
} from "@agent-dock/protocol";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  executeEnvironmentRecipe,
  resolveToolWorkspacePath,
  safeToolEnvironment,
  ToolWorkerError,
  validateToolEnvironment,
} from "../src/tool-worker.ts";

function recipeEnvironment(recipe: EnvironmentRecipe): EnvironmentRuntimeSnapshot {
  return {
    environmentVersionId: "10000000-0000-4000-8000-000000000001",
    versionNumber: 2,
    profileKey: "agent-dock-fullstack",
    profileVersion: "1",
    imageRevision: "expected-revision",
    specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
    recipe,
    recipeSha256: createHash("sha256").update(canonicalEnvironmentRecipeJson(recipe)).digest("hex"),
  };
}

describe("credential-free Tool Sandbox worker", () => {
  it("constructs a fixed subprocess environment without inheriting trusted credentials", () => {
    process.env.AGENT_DOCK_RUNTIME_API_KEY = "admg_should-never-cross";
    process.env.AGENT_DOCK_SANDBOX_MANAGER_TOKEN = "manager-should-never-cross";
    process.env.DATABASE_URL = "postgresql://should-never-cross";
    try {
      const environment = safeToolEnvironment();
      expect(environment).toEqual({
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/tmp/agent-dock-tool-home",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/workspace",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_LFS_SKIP_SMUDGE: "1",
      });
      expect(JSON.stringify(environment)).not.toMatch(/admg_|manager-should|postgresql:/);
    } finally {
      delete process.env.AGENT_DOCK_RUNTIME_API_KEY;
      delete process.env.AGENT_DOCK_SANDBOX_MANAGER_TOKEN;
      delete process.env.DATABASE_URL;
    }
  });

  it("keeps every remote file path beneath the isolated workspace", () => {
    expect(resolveToolWorkspacePath("src/Main.java")).toBe("/workspace/src/Main.java");
    expect(resolveToolWorkspacePath("/workspace/src/Main.java")).toBe("/workspace/src/Main.java");
    for (const path of ["../etc/passwd", "/etc/passwd", "src\\escape", "bad\0path"]) {
      expect(() => resolveToolWorkspacePath(path)).toThrow(ToolWorkerError);
    }
  });

  it("fails closed before probing when the physical image revision differs", async () => {
    await expect(
      validateToolEnvironment(
        {
          environmentVersionId: "10000000-0000-4000-8000-000000000001",
          versionNumber: 1,
          profileKey: "agent-dock-fullstack",
          profileVersion: "1",
          imageRevision: "expected-revision",
          specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        },
        "different-revision",
      ),
    ).rejects.toMatchObject({ code: "environment_image_mismatch", retryable: false });
  });

  it("runs a bounded setup and verification recipe without persisting raw command output", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-environment-recipe-"));
    const recipe: EnvironmentRecipe = {
      schemaVersion: 1,
      setupCommands: [
        {
          id: "write-marker",
          command: "printf configured > marker.txt; printf private-diagnostic",
          cwd: ".",
          timeoutMs: 1_000,
          network: "none",
        },
      ],
      verificationCommands: [
        {
          id: "verify-marker",
          command: 'test "$(cat marker.txt)" = configured',
          cwd: ".",
          timeoutMs: 1_000,
          network: "none",
        },
      ],
    };
    try {
      const results = await executeEnvironmentRecipe(recipeEnvironment(recipe), workspace);
      expect(await readFile(resolve(workspace, "marker.txt"), "utf8")).toBe("configured");
      expect(results).toMatchObject([
        { id: "write-marker", phase: "setup", exitCode: 0 },
        { id: "verify-marker", phase: "verification", exitCode: 0 },
      ]);
      expect(JSON.stringify(results)).not.toContain("private-diagnostic");
      expect(results.every((result) => /^[0-9a-f]{64}$/.test(result.outputSha256))).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when a recipe asks for dependency network before an egress policy exists", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-environment-network-"));
    const recipe: EnvironmentRecipe = {
      schemaVersion: 1,
      dependencyHosts: ["registry.npmjs.org"],
      setupCommands: [
        {
          id: "network-probe",
          command: "true",
          cwd: ".",
          timeoutMs: 1_000,
          network: "dependency",
        },
      ],
      verificationCommands: [
        {
          id: "offline-probe",
          command: "true",
          cwd: ".",
          timeoutMs: 1_000,
          network: "none",
        },
      ],
    };
    try {
      await expect(
        executeEnvironmentRecipe(recipeEnvironment(recipe), workspace),
      ).rejects.toMatchObject({
        code: "environment_dependency_network_unavailable",
        retryable: false,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("injects an ephemeral proxy only into dependency recipe commands", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-environment-proxy-"));
    const recipe: EnvironmentRecipe = {
      schemaVersion: 1,
      dependencyHosts: ["registry.npmjs.org"],
      setupCommands: [
        {
          id: "proxy-evidence",
          command:
            'test -n "$HTTPS_PROXY"; test "$NO_PROXY" = ""; printf configured > proxy-marker.txt',
          cwd: ".",
          timeoutMs: 1_000,
          network: "dependency",
        },
      ],
      verificationCommands: [
        {
          id: "proxy-cleared",
          command: 'test -z "${HTTPS_PROXY:-}"; test "$(cat proxy-marker.txt)" = configured',
          cwd: ".",
          timeoutMs: 1_000,
          network: "none",
        },
      ],
    };
    try {
      const setup = await executeEnvironmentRecipe(recipeEnvironment(recipe), workspace, {
        dependencyProxy: {
          host: "10.43.0.53",
          port: 3_128,
          capability: `adpc1_${"a".repeat(64)}.${"b".repeat(86)}`,
          publicKeyFingerprint: "c".repeat(64),
        },
        environmentStage: { type: "dependency_setup" },
        verifyDependencyProxy: async (proxy) => {
          expect(proxy.publicKeyFingerprint).toBe("c".repeat(64));
        },
      });
      expect(setup).toMatchObject([{ id: "proxy-evidence", phase: "setup", exitCode: 0 }]);
      await expect(
        executeEnvironmentRecipe(recipeEnvironment(recipe), workspace, {
          environmentStage: {
            type: "offline_restore",
            setupCommands: setup,
          },
        }),
      ).resolves.toMatchObject([
        { id: "proxy-evidence", phase: "setup", exitCode: 0 },
        { id: "proxy-cleared", phase: "verification", exitCode: 0 },
      ]);
      expect(await readFile(resolve(workspace, "proxy-marker.txt"), "utf8")).toBe("configured");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("kills detached recipe descendants before the temporary network authority can outlive setup", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "agent-dock-environment-descendant-"));
    const recipe: EnvironmentRecipe = {
      schemaVersion: 1,
      setupCommands: [
        {
          id: "background-process",
          command: "(sleep 1; printf escaped > background.txt) </dev/null >/dev/null 2>&1 &",
          cwd: ".",
          timeoutMs: 1_000,
          network: "none",
        },
      ],
      verificationCommands: [
        {
          id: "verify-shell",
          command: "true",
          cwd: ".",
          timeoutMs: 1_000,
          network: "none",
        },
      ],
    };
    try {
      await executeEnvironmentRecipe(recipeEnvironment(recipe), workspace);
      await delay(1_200);
      await expect(access(resolve(workspace, "background.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
