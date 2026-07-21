import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatApp, { AuthScreen, ToolActivity } from "../src/ChatApp.tsx";
import { AgentDockApi } from "../src/api.ts";
import { WorkspaceInspector } from "../src/WorkspaceInspector.tsx";

describe("product chat experience", () => {
  it("restores a durable login without rendering the old operator console", () => {
    const markup = renderToStaticMarkup(<ChatApp />);
    expect(markup).toContain("AgentDock");
    expect(markup).toContain("正在恢复登录状态");
    expect(markup).not.toContain("PostgreSQL outbox");
    expect(markup).not.toContain("Configure tenant model credential");
  });

  it("renders familiar username/password login and registration without API-token fields", () => {
    const markup = renderToStaticMarkup(
      <AuthScreen
        api={new AgentDockApi(async () => new Response(null, { status: 500 }))}
        onAuthenticated={() => undefined}
      />,
    );
    expect(markup).toContain("登录");
    expect(markup).toContain("注册");
    expect(markup).toContain("用户名");
    expect(markup).toContain("密码");
    expect(markup).not.toContain("API token");
    expect(markup).not.toContain("配置模型");
  });

  it("renders the product inspector navigation without executing browser effects", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceInspector
        api={new AgentDockApi(async () => new Response(null, { status: 500 }))}
        busy={false}
        onClose={() => undefined}
        onError={() => undefined}
        onForked={async () => undefined}
        onRetry={async () => undefined}
        onSessionChanged={async () => undefined}
        refreshSignal={0}
        role="owner"
        sessionId="10000000-0000-4000-8000-000000000001"
        source={{ kind: "sample_java", status: "ready" }}
      />,
    );
    expect(markup).toContain("Session inspector");
    expect(markup).toContain("workspace");
    expect(markup).toContain("runs");
    expect(markup).toContain("tests");
    expect(markup).toContain("usage");
    expect(markup).toContain("activity");
    expect(markup).toContain("Versioned workspace");
  });

  it("renders Pi-style command output instead of a collapsed JSON tool card", () => {
    const markup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:bash-1",
          toolCallId: "bash-1",
          toolName: "bash",
          input: { command: "python3 bubble_sort.py" },
          output: {
            content: [
              {
                type: "text",
                text: "/bin/bash: python3: command not found\n\nCommand exited with code 127",
              },
            ],
            details: {},
          },
          status: "failed",
          firstSequence: 4,
          lastSequence: 5,
          startedAt: "2026-07-21T00:00:00.000Z",
          completedAt: "2026-07-21T00:00:01.240Z",
        }}
      />,
    );
    expect(markup).toContain("$</span><code>python3 bubble_sort.py</code>");
    expect(markup).toContain("python3: command not found");
    expect(markup).toContain("Command exited with code 127");
    expect(markup).toContain("Took 1.2s");
    expect(markup).not.toContain("&quot;content&quot;");
    expect(markup).not.toContain("输入</span>");
  });

  it("renders write paths and a bounded source preview like Pi", () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${String(index + 1)}`).join(
      "\n",
    );
    const markup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:write-1",
          toolCallId: "write-1",
          toolName: "write",
          input: { path: "/workspace/bubble_sort.py", content },
          output: {
            content: [
              {
                type: "text",
                text: "Successfully wrote 151 bytes to /workspace/bubble_sort.py",
              },
            ],
          },
          status: "completed",
          firstSequence: 6,
          lastSequence: 7,
          startedAt: "2026-07-21T00:00:00.000Z",
          completedAt: "2026-07-21T00:00:00.010Z",
        }}
      />,
    );
    expect(markup).toContain("<strong>write</strong><code>/workspace/bubble_sort.py</code>");
    expect(markup).toContain("line 1");
    expect(markup).toContain("4 more lines");
    expect(markup).not.toContain("Successfully wrote");
    expect(markup).toContain("Took 0.0s");
  });

  it("renders a partial write call as genuinely streaming highlighted source", () => {
    const markup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:write-streaming",
          toolCallId: "write-streaming",
          toolName: "write",
          input: null,
          inputJson:
            '{"path":"bubble_sort.py","content":"def bubble_sort(values):\\n    return values',
          status: "preparing",
          firstSequence: 6,
          startedAt: "2026-07-21T00:00:00.000Z",
        }}
      />,
    );
    expect(markup).toContain("正在生成");
    expect(markup).toContain("product-tool-stream-cursor");
    expect(markup).toContain("def bubble_sort");
    expect(markup).toContain("bubble_sort");
  });
});
