import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type CubeApiAuthorizerConfig = Readonly<{
  host: string;
  port: number;
  credential: string;
}>;

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("Cube API authorizer port is invalid");
  }
  return parsed;
}

async function readCredential(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("Cube API authorizer credential path must be absolute");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o007) !== 0 ||
      metadata.size < 32 ||
      metadata.size > 4_096
    ) {
      throw new TypeError("Cube API authorizer credential file is not private and bounded");
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (value.length < 32 || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError("Cube API authorizer credential is invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function loadCubeApiAuthorizerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CubeApiAuthorizerConfig> {
  const host = environment.HOST ?? "127.0.0.1";
  if (host.length < 1 || host.length > 253 || /[\u0000-\u0020\u007f/]/.test(host)) {
    throw new TypeError("Cube API authorizer host is invalid");
  }
  const path = environment.AGENT_DOCK_CUBE_API_AUTH_CREDENTIAL_FILE;
  if (path === undefined || path.length === 0) {
    throw new TypeError("Cube API authorizer credential file is missing");
  }
  return {
    host,
    port: integer(environment.PORT, 8_080),
    credential: await readCredential(path),
  };
}
