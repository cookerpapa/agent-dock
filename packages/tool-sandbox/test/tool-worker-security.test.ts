import { describe, expect, it } from "vitest";
import {
  resolveToolWorkspacePath,
  safeToolEnvironment,
  ToolWorkerError,
} from "../src/tool-worker.ts";

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
});
