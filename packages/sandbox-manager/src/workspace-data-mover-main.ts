import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { KopiaWorkspaceDataMover, WorkspaceDataMoverServer } from "./workspace-data-mover.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length < 1) throw new TypeError(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

async function secret(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new TypeError("Secret path is invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 8_192) {
      throw new TypeError("Secret file is invalid");
    }
    return (await handle.readFile("utf8")).replace(/\r?\n$/, "");
  } finally {
    await handle.close();
  }
}

function parseAwsCredentials(value: string): { accessKey: string; secretAccessKey: string } {
  const match =
    /^\[default\]\naws_access_key_id = ([A-Za-z0-9][A-Za-z0-9_-]{15,63})\naws_secret_access_key = ([A-Za-z0-9_-]{43,128})\n?$/.exec(
      value,
    );
  if (match === null) throw new TypeError("Workspace Kopia AWS credentials are invalid");
  const accessKey = match[1];
  const secretAccessKey = match[2];
  if (accessKey === undefined || secretAccessKey === undefined) {
    throw new TypeError("Workspace Kopia AWS credentials are invalid");
  }
  return { accessKey, secretAccessKey };
}

const aws = parseAwsCredentials(
  await secret(required("AGENT_DOCK_WORKSPACE_KOPIA_AWS_CREDENTIALS_FILE")),
);
const mover = new KopiaWorkspaceDataMover({
  workspaceRoot: required("AGENT_DOCK_WORKSPACE_POSIX_ROOT"),
  stateRoot: required("AGENT_DOCK_WORKSPACE_DATA_MOVER_STATE_ROOT"),
  kopiaConfigPath: required("AGENT_DOCK_WORKSPACE_KOPIA_CONFIG_PATH"),
  kopiaCacheDirectory: required("AGENT_DOCK_WORKSPACE_KOPIA_CACHE_DIRECTORY"),
  repositoryPassword: await secret(required("AGENT_DOCK_WORKSPACE_KOPIA_REPOSITORY_PASSWORD_FILE")),
  s3: {
    bucket: required("AGENT_DOCK_WORKSPACE_KOPIA_S3_BUCKET"),
    endpoint: required("AGENT_DOCK_WORKSPACE_KOPIA_S3_ENDPOINT"),
    region: process.env.AGENT_DOCK_WORKSPACE_KOPIA_S3_REGION ?? "us-east-1",
    prefix: process.env.AGENT_DOCK_WORKSPACE_KOPIA_S3_PREFIX ?? "production/kopia/v1/",
    accessKey: aws.accessKey,
    secretAccessKey: aws.secretAccessKey,
    disableTls: process.env.AGENT_DOCK_WORKSPACE_KOPIA_S3_DISABLE_TLS === "true",
  },
});
const server = new WorkspaceDataMoverServer({
  host: process.env.AGENT_DOCK_WORKSPACE_DATA_MOVER_HOST ?? "127.0.0.1",
  port: integer("AGENT_DOCK_WORKSPACE_DATA_MOVER_PORT", 4_500, 1, 65_535),
  serviceToken: await secret(required("AGENT_DOCK_WORKSPACE_DATA_MOVER_TOKEN_FILE")),
  mover,
});
await server.listen();
process.stdout.write("AgentDock Workspace Data Mover ready\n");

let closing: Promise<void> | undefined;
const close = (): Promise<void> => (closing ??= server.close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
