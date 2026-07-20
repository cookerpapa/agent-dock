import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatApp, { AuthScreen } from "../src/ChatApp.tsx";
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
});
