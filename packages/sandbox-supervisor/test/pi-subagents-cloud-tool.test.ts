import { describe, expect, it } from "vitest";
import {
  createPiSubagentsCloudTool,
  type ExternalJobHandle,
  type ExternalJobResult,
  type ExternalJobStartInput,
} from "../src/pi-subagents-cloud-tool.ts";

describe("pi-subagents cloud Tool adapter", () => {
  it("executes the upstream workflow contract while delegating leaves to the cloud provider", async () => {
    const starts: ExternalJobStartInput[] = [];
    const jobs = new Map<string, string>();
    const tool = await createPiSubagentsCloudTool({
      context: {
        parentSessionId: "00000000-0000-4000-8000-000000000001",
        model: { provider: "test", id: "test" },
        thinkingLevel: "off",
      },
      coordinator: {
        start(input): ExternalJobHandle {
          starts.push(input);
          const providerJobId = `job-${starts.length}`;
          jobs.set(providerJobId, `cloud result ${starts.length}`);
          return { providerJobId, state: "completed" };
        },
        status(providerJobId): ExternalJobHandle {
          return { providerJobId, state: "completed" };
        },
        result(providerJobId): ExternalJobResult {
          return { providerJobId, state: "completed", output: jobs.get(providerJobId)! };
        },
        reattach(providerJobId): ExternalJobHandle {
          return { providerJobId, state: "completed" };
        },
        cancel(providerJobId): ExternalJobHandle {
          return { providerJobId, state: "stopped" };
        },
      },
    });

    expect(tool.name).toBe("subagent");
    const result = await tool.execute(
      "tool-call-1",
      {
        workflowScript: `return runs.all([
          { key: "first", agent: "oracle", task: "Challenge the plan" },
          { key: "second", agent: "scout", task: "Inspect the repository" }
        ])`,
      },
      new AbortController().signal,
    );

    expect(starts, JSON.stringify(result)).toHaveLength(2);
    expect(starts.map((start) => start.agent).sort()).toEqual(["oracle", "scout"]);
    expect(starts.find((start) => start.agent === "oracle")?.options).toMatchObject({
      contextMode: "fork",
      workspaceMode: "none",
      requestedToolCapabilities: [],
    });
    expect(starts.find((start) => start.agent === "scout")?.options).toMatchObject({
      contextMode: "fresh",
      workspaceMode: "shared_serialized",
      requestedToolCapabilities: ["read", "bash"],
    });
    const output = result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(output).toContain("cloud result 1");
    expect(output).toContain("cloud result 2");
  }, 30_000);

  it("does not expose local profile-management actions through the cloud adapter", async () => {
    const tool = await createPiSubagentsCloudTool({
      context: { parentSessionId: "00000000-0000-4000-8000-000000000002" },
      coordinator: {
        start: async () => {
          throw new Error("not expected");
        },
        status: async () => {
          throw new Error("not expected");
        },
        result: async () => {
          throw new Error("not expected");
        },
        reattach: async () => {
          throw new Error("not expected");
        },
        cancel: async () => {
          throw new Error("not expected");
        },
      },
    });
    const result = await tool.execute(
      "tool-call-2",
      { action: "create", agent: "untrusted" },
      new AbortController().signal,
    );
    const output = result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(output).toContain("not local profile management");
  }, 30_000);

  it("maps upstream worktree isolation onto an isolated cloud Workspace", async () => {
    const starts: ExternalJobStartInput[] = [];
    const tool = await createPiSubagentsCloudTool({
      context: { parentSessionId: "00000000-0000-4000-8000-000000000003" },
      coordinator: {
        start(input): ExternalJobHandle {
          starts.push(input);
          return { providerJobId: "job-isolated", state: "completed" };
        },
        status: () => ({ providerJobId: "job-isolated", state: "completed" }),
        result: () => ({
          providerJobId: "job-isolated",
          state: "completed",
          output: "isolated result",
        }),
        reattach: () => ({ providerJobId: "job-isolated", state: "completed" }),
        cancel: () => ({ providerJobId: "job-isolated", state: "stopped" }),
      },
    });
    await tool.execute(
      "tool-call-isolated",
      {
        workflowScript: `return runs.run("isolated", {agent:"worker", task:"Try another implementation", worktree:true})`,
      },
      new AbortController().signal,
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.options).toMatchObject({
      contextMode: "fresh",
      workspaceMode: "isolated",
      requestedToolCapabilities: expect.arrayContaining(["read", "write", "edit", "bash"]),
    });
  }, 30_000);

  it("propagates parent Tool cancellation to every admitted cloud child", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const cancelled: string[] = [];
    const tool = await createPiSubagentsCloudTool({
      context: { parentSessionId: "00000000-0000-4000-8000-000000000004" },
      coordinator: {
        start: () => {
          notifyStarted();
          return { providerJobId: "job-cancel", state: "running" };
        },
        status: () => ({ providerJobId: "job-cancel", state: "running" }),
        result: () => ({ providerJobId: "job-cancel", state: "stopped" }),
        reattach: () => ({ providerJobId: "job-cancel", state: "running" }),
        cancel: (providerJobId) => {
          cancelled.push(providerJobId);
          return { providerJobId, state: "stopped" };
        },
      },
    });
    const controller = new AbortController();
    const execution = tool.execute(
      "tool-call-cancel",
      {
        workflowScript: `return runs.run("cancel", {agent:"worker", task:"Wait"})`,
      },
      controller.signal,
    );
    await started;
    controller.abort();
    await execution;
    expect(cancelled).toEqual(["job-cancel"]);
  }, 30_000);
});
