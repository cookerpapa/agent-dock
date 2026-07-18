import { describe, expect, it } from "vitest";
import {
  DomainModelValidationError,
  parseModelProfile,
  parseResolvedTurnModel,
  resolveTurnModel,
} from "../src/index.ts";

function modelProfile() {
  return {
    profileId: "default-codex",
    provider: "openai-codex",
    modelId: "gpt-5.4-mini",
    defaultThinkingLevel: "off",
    allowedThinkingLevels: ["off", "low"],
    credentialBindingId: "owner-chatgpt-subscription",
    credentialBindingVersion: 3,
    enabled: true,
  } as const;
}

describe("model profiles", () => {
  it("resolves the default allowlisted profile into an immutable turn-shaped snapshot", () => {
    expect(resolveTurnModel(modelProfile())).toEqual({
      profileId: "default-codex",
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "off",
      credentialBindingId: "owner-chatgpt-subscription",
      credentialBindingVersion: 3,
    });
    expect(resolveTurnModel(modelProfile(), "low").thinkingLevel).toBe("low");
  });

  it("rejects a thinking level outside the server profile", () => {
    expect(() => resolveTurnModel(modelProfile(), "xhigh")).toThrow(
      "Thinking level xhigh is not allowed",
    );
  });

  it("rejects disabled profiles and inconsistent defaults", () => {
    expect(() => resolveTurnModel({ ...modelProfile(), enabled: false })).toThrow(
      DomainModelValidationError,
    );
    expect(() =>
      parseModelProfile({
        ...modelProfile(),
        defaultThinkingLevel: "medium",
      }),
    ).toThrow("defaultThinkingLevel must be included");
  });

  it("rejects credential material and unreviewed provider fields", () => {
    expect(() =>
      parseModelProfile({
        ...modelProfile(),
        refreshToken: "must-never-enter-domain-state",
      }),
    ).toThrow(DomainModelValidationError);
    expect(() =>
      parseModelProfile({
        ...modelProfile(),
        baseUrl: "https://unreviewed.invalid",
      }),
    ).toThrow(DomainModelValidationError);
  });

  it("validates persisted resolved snapshots as a closed schema", () => {
    const snapshot = resolveTurnModel(modelProfile());
    expect(parseResolvedTurnModel(snapshot)).toEqual(snapshot);
    expect(() => parseResolvedTurnModel({ ...snapshot, accessToken: "secret" })).toThrow(
      DomainModelValidationError,
    );
  });
});
