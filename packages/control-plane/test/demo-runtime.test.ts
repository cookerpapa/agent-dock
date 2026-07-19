import type { ProjectResource, SessionResource } from "@agent-dock/protocol";
import { describe, expect, it } from "vitest";
import { startDemoRuntime } from "../src/demo.ts";

describe("local browser demo runtime", () => {
  it("migrates, seeds, serves the public API, and closes on an ephemeral port", async () => {
    const runtime = await startDemoRuntime({ port: 0 });
    try {
      const projectResponse = await fetch(`${runtime.url}/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Demo runtime smoke test" }),
      });
      expect(projectResponse.status).toBe(201);
      const project = (await projectResponse.json()) as ProjectResource;

      const sessionResponse = await fetch(
        `${runtime.url}/v1/projects/${project.projectId}/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: project.workspaceId }),
        },
      );
      expect(sessionResponse.status).toBe(201);
      expect((await sessionResponse.json()) as SessionResource).toMatchObject({
        projectId: project.projectId,
        workspaceId: project.workspaceId,
        state: "cold",
      });
    } finally {
      await runtime.close();
    }
    await expect(fetch(`${runtime.url}/v1/projects`)).rejects.toThrow();
  }, 30_000);
});
