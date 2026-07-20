import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../src/App.tsx";
import { AgentDockApi } from "../src/api.ts";
import { WorkspaceInspector } from "../src/WorkspaceInspector.tsx";

describe("Pi-export-inspired session page", () => {
  it("renders the runtime boundary, durable cursor, and usable composer without browser globals", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("AgentDock");
    expect(markup).toContain("PostgreSQL outbox");
    expect(markup).toContain("resumable SSE");
    expect(markup).toContain("networkless sandbox");
    expect(markup).toContain("durable through: #0");
    expect(markup).toContain("Run the tests, repair the Java bug");
    expect(markup).toContain("new workspace");
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
