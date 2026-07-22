import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createPublicKey } from "node:crypto";

export type DependencyEgressProxyConfig = Readonly<{
  host: string;
  port: number;
  publicKeyPath: string;
}>;

function port(value: string | undefined): number {
  const parsed = Number(value ?? "3128");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("AGENT_DOCK_DEPENDENCY_EGRESS_PORT is invalid");
  }
  return parsed;
}

export function loadDependencyEgressProxyConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DependencyEgressProxyConfig {
  const host = environment.AGENT_DOCK_DEPENDENCY_EGRESS_HOST ?? "0.0.0.0";
  if (host !== "0.0.0.0" && host !== "127.0.0.1") {
    throw new TypeError("AGENT_DOCK_DEPENDENCY_EGRESS_HOST is invalid");
  }
  const publicKeyPath = environment.AGENT_DOCK_DEPENDENCY_EGRESS_PUBLIC_KEY_FILE;
  if (
    publicKeyPath === undefined ||
    !isAbsolute(publicKeyPath) ||
    publicKeyPath.length > 4_096 ||
    publicKeyPath.includes("\0")
  ) {
    throw new TypeError("AGENT_DOCK_DEPENDENCY_EGRESS_PUBLIC_KEY_FILE is invalid");
  }
  return { host, port: port(environment.AGENT_DOCK_DEPENDENCY_EGRESS_PORT), publicKeyPath };
}

export function publicKeyFileReader(path: string): () => Promise<Buffer> {
  return async () => {
    const value = await readFile(path);
    if (value.byteLength < 80 || value.byteLength > 4_096) {
      throw new TypeError("Dependency egress public key file is invalid");
    }
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("Dependency egress public key file is invalid");
    }
    return value;
  };
}
