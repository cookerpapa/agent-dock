import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPage } from "../src/AdminPage.tsx";
import { AuthScreen } from "../src/AuthScreen.tsx";
import ChatApp from "../src/ChatApp.tsx";
import { ConversationOutline } from "../src/ConversationOutline.tsx";
import { ConversationTreeNavigator } from "../src/ConversationTreeNavigator.tsx";
import { ConversationTurn, ToolActivity } from "../src/ConversationTurn.tsx";
import { AgentDockApi } from "../src/api.ts";
import type { TurnView } from "../src/session-view.ts";
import { WorkspaceInspector } from "../src/WorkspaceInspector.tsx";

function turn(turnId: string, prompt: string): TurnView {
  return {
    runId: null,
    turnId,
    commandId: null,
    mailboxPosition: null,
    prompt,
    acceptedAt: null,
    projection: "canonical",
    supersededByRunId: null,
    rewoundFromRunId: null,
    status: "completed",
    items: [],
    startedSequence: null,
    terminalSequence: null,
    stopReason: "stop",
    failure: null,
    cancellation: null,
    workspacePatch: null,
  };
}

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

  it("renders platform configuration in a dedicated administrator page", () => {
    const markup = renderToStaticMarkup(
      <AdminPage
        api={new AgentDockApi(async () => new Response(null, { status: 500 }))}
        identity={{
          tenantId: "10000000-0000-4000-8000-000000000001",
          tenantSlug: "platform",
          userId: "10000000-0000-4000-8000-000000000002",
          displayName: "Platform Admin",
          role: "owner",
          platformAdministrator: true,
        }}
        onLogout={() => undefined}
      />,
    );
    expect(markup).toContain("AgentDock 管理后台");
    expect(markup).toContain("Pi Worker 模型");
    expect(markup).toContain("CubeSandbox 公网代理");
    expect(markup).not.toContain("最近对话");
  });

  it("renders the Workspace as a directory without executing browser effects", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceInspector
        api={new AgentDockApi(async () => new Response(null, { status: 500 }))}
        onClose={() => undefined}
        onError={() => undefined}
        refreshSignal={0}
        sessionId="10000000-0000-4000-8000-000000000001"
        workspaceName="order-service"
      />,
    );
    expect(markup).toContain("WORKSPACE");
    expect(markup).toContain("order-service");
    expect(markup).toContain("/workspace");
    expect(markup).not.toContain("runs");
    expect(markup).not.toContain("usage");
  });

  it("renders historical user questions as a compact conversation navigator", () => {
    const markup = renderToStaticMarkup(
      <ConversationOutline
        scrollerRef={{ current: null }}
        turns={[
          turn("10000000-0000-4000-8000-000000000011", "分析一下当前架构"),
          turn("10000000-0000-4000-8000-000000000012", "然后修复所有测试"),
        ]}
      />,
    );
    expect(markup).toContain("对话导航");
    expect(markup).toContain("分析一下当前架构");
    expect(markup).toContain("然后修复所有测试");
    expect(markup).toContain('aria-current="true"');
  });

  it("renders Pi conversation forks in focused and whole-tree navigation", () => {
    const rootSessionId = "10000000-0000-4000-8000-000000000021";
    const childSessionId = "10000000-0000-4000-8000-000000000022";
    const rootTurnId = "10000000-0000-4000-8000-000000000023";
    const rootEntryId = "10000000-0000-4000-8000-000000000024";
    const markup = renderToStaticMarkup(
      <ConversationTreeNavigator
        loading={false}
        onNavigate={() => undefined}
        onViewChange={() => undefined}
        scrollerRef={{ current: null }}
        tree={{
          rootSessionId,
          currentSessionId: childSessionId,
          view: "full",
          branches: [
            {
              sessionId: rootSessionId,
              title: "排序算法",
              parentSessionId: null,
              forkedFromTurnId: null,
              forkedFromEntryId: null,
              current: false,
              entries: [
                {
                  entryId: "10000000-0000-4000-8000-000000000025",
                  parentEntryId: null,
                  turnId: rootTurnId,
                  role: "user",
                  text: "写一个插入排序并测试",
                  finalAssistant: false,
                  createdAt: "2026-08-15T00:00:00.000Z",
                },
                {
                  entryId: rootEntryId,
                  parentEntryId: "10000000-0000-4000-8000-000000000025",
                  turnId: rootTurnId,
                  role: "assistant",
                  text: "插入排序已经通过测试。",
                  finalAssistant: true,
                  createdAt: "2026-08-15T00:00:01.000Z",
                },
              ],
            },
            {
              sessionId: childSessionId,
              title: "改用泛型实现",
              parentSessionId: rootSessionId,
              forkedFromTurnId: rootTurnId,
              forkedFromEntryId: rootEntryId,
              current: true,
              entries: [],
            },
          ],
        }}
        view="full"
      />,
    );
    expect(markup).toContain("对话导航");
    expect(markup).toContain("当前分支");
    expect(markup).toContain("整棵树");
    expect(markup).toContain("写一个插入排序并测试");
    expect(markup).toContain("改用泛型实现");
    expect(markup).toContain("product-tree-user");
    expect(markup).toContain("product-tree-assistant");
  });

  it("does not render the removed per-turn patch viewer", () => {
    const renderedTurn = {
      ...turn("10000000-0000-4000-8000-000000000013", "修改代码"),
      workspacePatch: {
        format: "unified_diff" as const,
        patch: "diff --git a/secret.ts b/secret.ts\n",
        truncated: false,
      },
    };
    const markup = renderToStaticMarkup(<ConversationTurn turn={renderedTurn} />);
    expect(markup).toContain("修改代码");
    expect(markup).not.toContain("查看本轮代码修改");
    expect(markup).not.toContain("secret.ts");
  });

  it("offers a fork action only after a completed final response", () => {
    const markup = renderToStaticMarkup(
      <ConversationTurn
        canFork
        onFork={() => undefined}
        turn={turn("10000000-0000-4000-8000-000000000026", "保留这一条路径")}
      />,
    );
    expect(markup).toContain("从此对话开始");
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
