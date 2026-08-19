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
    expect(output).not.toContain('action: "status"');
    expect(output).not.toContain("/tmp/");
  }, 30_000);

  it("does not expose mutable local profile-management actions through the cloud adapter", async () => {
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
    expect(output).toContain("management actions are unavailable across Worker replacement");
  }, 30_000);

  it("keeps the upstream read-only agent discovery action available", async () => {
    const tool = await createPiSubagentsCloudTool({
      context: { parentSessionId: "00000000-0000-4000-8000-000000000012" },
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
      "tool-call-list",
      { action: "list" },
      new AbortController().signal,
    );
    const output = result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(output).toContain("worker");
  }, 30_000);

  it("accepts the upstream structured single-child form without a failed compatibility call", async () => {
    const starts: ExternalJobStartInput[] = [];
    const tool = await createPiSubagentsCloudTool({
      context: { parentSessionId: "00000000-0000-4000-8000-000000000022" },
      coordinator: {
        start(input): ExternalJobHandle {
          starts.push(input);
          return { providerJobId: "job-structured", state: "completed" };
        },
        status: () => ({ providerJobId: "job-structured", state: "completed" }),
        result: () => ({
          providerJobId: "job-structured",
          state: "completed",
          output: "structured result",
        }),
        reattach: () => ({ providerJobId: "job-structured", state: "completed" }),
        cancel: () => ({ providerJobId: "job-structured", state: "stopped" }),
      },
    });
    const result = await tool.execute(
      "tool-call-structured",
      { agent: "worker", task: "Implement insertion sort" },
      new AbortController().signal,
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      agent: "worker",
      options: { contextMode: "fork", workspaceMode: "shared_serialized" },
    });
    expect(starts[0]!.prompt).toContain("Implement insertion sort");
    expect(starts[0]!.prompt).not.toContain("Write your findings to exactly this path");
    expect(JSON.stringify(result)).toContain("structured result");
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
      contextMode: "fork",
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

  it("surfaces durable cross-Worker supervisor requests instead of appearing stalled", async () => {
    const updates: string[] = [];
    const tool = await createPiSubagentsCloudTool({
      context: { parentSessionId: "00000000-0000-4000-8000-000000000005" },
      coordinator: {
        start: () => ({ providerJobId: "job-blocked", state: "running" }),
        status: () => ({
          providerJobId: "job-blocked",
          state: "blocked",
          coordinationRequest: {
            requestId: "00000000-0000-4000-8000-000000000099",
            reason: "need_decision",
            message: "Should this API preserve the old wire format?",
            expectsReply: true,
          },
        }),
        result: () => ({ providerJobId: "job-blocked", state: "running" }),
        reattach: () => ({ providerJobId: "job-blocked", state: "running" }),
        cancel: () => ({ providerJobId: "job-blocked", state: "stopped" }),
      },
    });
    const result = await tool.execute(
      "tool-call-blocked",
      { agent: "worker", task: "Implement the API" },
      new AbortController().signal,
      (update) => {
        updates.push(
          update.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        );
      },
    );
    const output = result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(updates.join("\n")).toContain("正在等待父 Agent 决策");
    expect(output).toContain("subagent_supervisor");
    expect(output).toContain("Should this API preserve the old wire format?");
  }, 30_000);

  it("waits for the durable Child Run after the local upstream shim times out", async () => {
    let childStartedAt = 0;
    const tool = await createPiSubagentsCloudTool({
      context: { parentSessionId: "00000000-0000-4000-8000-000000000006" },
      coordinator: {
        start: () => {
          childStartedAt = Date.now();
          return { providerJobId: "job-after-shim-timeout", state: "running" };
        },
        status: () => ({
          providerJobId: "job-after-shim-timeout",
          state: Date.now() - childStartedAt >= 250 ? "completed" : "running",
        }),
        result: () => ({
          providerJobId: "job-after-shim-timeout",
          state: "completed",
          output: "durable cloud result",
        }),
        reattach: () => ({ providerJobId: "job-after-shim-timeout", state: "running" }),
        cancel: () => ({ providerJobId: "job-after-shim-timeout", state: "stopped" }),
      },
    });
    const result = await tool.execute(
      "tool-call-after-shim-timeout",
      {
        workflowScript:
          'return runs.run("slow-cloud", {agent:"worker", task:"Finish remotely", timeoutMs:50})',
      },
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).toContain("durable cloud result");
    expect(JSON.stringify(result)).not.toContain("without a text result");
  }, 30_000);
});
