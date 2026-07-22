import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DependencyEgressCapabilityError,
  dependencyEgressPolicySha256,
  dependencyEgressPublicKeyFingerprint,
  dependencyEgressPublicKeyPem,
  mintDependencyEgressCapability,
  verifyDependencyEgressCapability,
} from "../src/index.ts";

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000001";

describe("dependency egress capability", () => {
  it("signs canonical exact-host policy with bounded authority", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const minted = mintDependencyEgressCapability({
      privateKey,
      activationId: ACTIVATION_ID,
      hosts: ["registry.npmjs.org", "files.pythonhosted.org"],
      nowMs: 1_000_000,
      ttlMs: 60_000,
      nonce: "abcdefghijklmnopqrstuv",
      maximumConnections: 3,
      maximumConcurrentConnections: 1,
      maximumBytes: 4_096,
      maximumConnectionDurationMs: 2_000,
    });
    expect(verifyDependencyEgressCapability(minted.token, publicKey, 1_030_000)).toEqual({
      version: 1,
      issuer: "agent-dock-sandbox-manager",
      audience: "agent-dock-dependency-egress",
      activationId: ACTIVATION_ID,
      policySha256: dependencyEgressPolicySha256(["files.pythonhosted.org", "registry.npmjs.org"]),
      hosts: ["files.pythonhosted.org", "registry.npmjs.org"],
      notBefore: 995_000,
      expiresAt: 1_060_000,
      maximumConnections: 3,
      maximumConcurrentConnections: 1,
      maximumBytes: 4_096,
      maximumConnectionDurationMs: 2_000,
      nonce: "abcdefghijklmnopqrstuv",
    });
    const publicPem = dependencyEgressPublicKeyPem(privateKey);
    expect(dependencyEgressPublicKeyFingerprint(publicPem)).toBe(
      dependencyEgressPublicKeyFingerprint(
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
    );
  });

  it("rejects tampering, expiry, wildcards, IP literals and duplicates", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { token } = mintDependencyEgressCapability({
      privateKey,
      activationId: ACTIVATION_ID,
      hosts: ["registry.npmjs.org"],
      nowMs: 1_000_000,
      ttlMs: 60_000,
    });
    const [payload, signature] = token.split(".");
    expect(() =>
      verifyDependencyEgressCapability(`${payload}x.${signature}`, publicKey, 1_001_000),
    ).toThrow(DependencyEgressCapabilityError);
    expect(() => verifyDependencyEgressCapability(token, publicKey, 1_060_000)).toThrow(
      /not active/,
    );
    for (const hosts of [
      ["*.npmjs.org"],
      ["127.0.0.1"],
      ["registry.npmjs.org", "registry.npmjs.org"],
    ]) {
      expect(() =>
        mintDependencyEgressCapability({ privateKey, activationId: ACTIVATION_ID, hosts }),
      ).toThrow(/policy/);
    }
  });
});
