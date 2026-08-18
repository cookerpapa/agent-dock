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
});
