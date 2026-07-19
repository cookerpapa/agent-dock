import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../src/App.tsx";

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
});
