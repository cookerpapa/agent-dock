import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OfficialKubernetesRuntimeClient } from "../src/index.ts";

const CA_DATA = Buffer.from("agent-dock-test-ca\n".repeat(32), "utf8").toString("base64");
const TOKEN = "t".repeat(48);

function kubeconfig(clusterFields = "", userFields = ""): string {
  return `apiVersion: v1
kind: Config
clusters:
  - name: agent-dock
    cluster:
      certificate-authority-data: ${CA_DATA}
      server: https://agent-dock-kubernetes:6443
${clusterFields}
contexts:
  - name: sandbox-manager
    context:
      cluster: agent-dock
      namespace: agent-dock-sandboxes
      user: sandbox-manager
current-context: sandbox-manager
users:
  - name: sandbox-manager
    user:
      token: ${TOKEN}
${userFields}`;
}

describe("official Kubernetes runtime client credential boundary", () => {
  it("accepts only an inline-CA, direct TLS bearer kubeconfig", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-dock-kubeconfig-"));
    try {
      const validPath = join(directory, "valid.yaml");
      await writeFile(validPath, kubeconfig(), { mode: 0o600 });
      expect(() => new OfficialKubernetesRuntimeClient(validPath)).not.toThrow();

      const proxyPath = join(directory, "proxy.yaml");
      await writeFile(proxyPath, kubeconfig("      proxy-url: http://proxy.invalid:8080"), {
        mode: 0o600,
      });
      expect(() => new OfficialKubernetesRuntimeClient(proxyPath)).toThrow(
        "not a fixed TLS bearer configuration",
      );

      const alternateCredentialPath = join(directory, "alternate-credential.yaml");
      await writeFile(
        alternateCredentialPath,
        kubeconfig("", `      username: unexpected\n      password: unexpected`),
        { mode: 0o600 },
      );
      expect(() => new OfficialKubernetesRuntimeClient(alternateCredentialPath)).toThrow(
        "not a fixed TLS bearer configuration",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
