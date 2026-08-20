import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  DevelopmentEnvironmentProtocolError,
  parseDevelopmentEnvironmentBrokerRequest,
  parseDevelopmentEnvironmentTerminalOpenRequest,
} from "../src/index.ts";

describe("development environment Broker protocol", () => {
  it("parses a deployment-owned provision request and rejects unknown fields", () => {
    const request = {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: "10000000-0000-4000-8000-000000000001",
      environmentId: "10000000-0000-4000-8000-000000000002",
      tenantId: "10000000-0000-4000-8000-000000000003",
      userId: "10000000-0000-4000-8000-000000000004",
      projectId: "10000000-0000-4000-8000-000000000005",
      workspaceId: "10000000-0000-4000-8000-000000000006",
      generation: 1,
      environment: {
        environmentVersionId: "10000000-0000-4000-8000-000000000007",
        versionNumber: 1,
        profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
        profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
        imageRevision: "development-test",
        specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
      workspaceSeed: { kind: "sample_java" },
    } as const;
    expect(parseDevelopmentEnvironmentBrokerRequest(request)).toMatchObject({
      type: "development_environment.provision",
      generation: 1,
    });
    expect(() =>
      parseDevelopmentEnvironmentBrokerRequest({ ...request, privileged: true }),
    ).toThrow(DevelopmentEnvironmentProtocolError);
  });

  it("binds terminal access to tenant, user and environment identities", () => {
    expect(
      parseDevelopmentEnvironmentTerminalOpenRequest({
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment_terminal.open",
        requestId: "20000000-0000-4000-8000-000000000001",
        environmentId: "20000000-0000-4000-8000-000000000002",
        tenantId: "20000000-0000-4000-8000-000000000003",
        userId: "20000000-0000-4000-8000-000000000004",
        rows: 24,
        cols: 100,
      }),
    ).toMatchObject({ rows: 24, cols: 100 });
  });
});
