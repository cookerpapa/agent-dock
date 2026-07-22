import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  isExpectedDefaultToolchain,
  parseEnvironmentRuntimeSnapshot,
  parseEnvironmentValidationReport,
} from "../src/index.ts";

const snapshot = {
  environmentVersionId: "10000000-0000-4000-8000-000000000001",
  versionNumber: 1,
  profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  imageRevision: "sha-0123456789abcdef",
  specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
} as const;

const tools = [
  { name: "node", version: "v24.12.0" },
  { name: "java", version: 'openjdk version "17.0.19" 2026-04-21' },
  { name: "python", version: "Python 3.11.2" },
  { name: "git", version: "git version 2.39.5" },
] as const;

describe("versioned project environment protocol", () => {
  it("accepts only the immutable operator profile snapshot", () => {
    expect(parseEnvironmentRuntimeSnapshot(snapshot)).toEqual(snapshot);
    expect(() =>
      parseEnvironmentRuntimeSnapshot({ ...snapshot, image: "user/image:latest" }),
    ).toThrow();
    expect(() => parseEnvironmentRuntimeSnapshot({ ...snapshot, profileVersion: "2" })).toThrow();
  });

  it("validates concrete gVisor and toolchain evidence", () => {
    const report = parseEnvironmentValidationReport({
      profileKey: snapshot.profileKey,
      profileVersion: snapshot.profileVersion,
      imageRevision: snapshot.imageRevision,
      specSha256: snapshot.specSha256,
      isolationBoundary: "gvisor",
      runtime: "runsc",
      networkMode: "deny_all",
      runAsUser: "1000:1000",
      readOnlyRootFilesystem: true,
      tools,
    });
    expect(isExpectedDefaultToolchain(report)).toBe(true);
    expect(
      isExpectedDefaultToolchain({
        ...report,
        tools: tools.map((tool) =>
          tool.name === "python" ? { ...tool, version: "Python 3.12.3" } : tool,
        ),
      }),
    ).toBe(false);
  });
});
