import { execFileSync, spawn } from "node:child_process";
import { access, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = resolve(repositoryRoot, "deploy/production/compose.yaml");
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environmentFile = resolve(runtimeDirectory, ".env");
const input = process.argv.slice(2);
if (input.length === 0) throw new Error("A Docker Compose command is required");
await access(environmentFile);

const imageRevision =
  process.env.AGENT_DOCK_IMAGE_REVISION ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
if (!/^[0-9a-f]{40}$/.test(imageRevision)) {
  throw new Error("AGENT_DOCK_IMAGE_REVISION must be a full lowercase Git commit");
}

const applicationSecretNames = [
  "api-token",
  "database-url",
  "github-app-private-key.pem",
  "github-gateway-token",
  "github-webhook-secret",
  "grafana-admin-password",
  "metrics-token",
  "model-credential-master-key",
  "sandbox-manager-token",
  "supervisor-enrollment-token",
  "supervisor-management-token",
];
const applicationSecrets = await Promise.all(
  applicationSecretNames.map((name) => lstat(resolve(runtimeDirectory, "secrets", name))),
);
const [applicationOwner] = applicationSecrets;
if (
  applicationOwner === undefined ||
  applicationOwner.uid === 0 ||
  applicationSecrets.some(
    (metadata) =>
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== applicationOwner.uid ||
      metadata.gid !== applicationOwner.gid,
  )
) {
  throw new Error("Production application secrets must share one private non-root owner");
}

const [command, ...commandArguments] = input;
const profileArguments = command === "build" ? ["--profile", "image-only"] : [];
const serviceArguments =
  command === "build" && commandArguments.length === 0
    ? [
        "control-plane",
        "supervisor-host",
        "sandbox-manager",
        "github-gateway",
        "web",
        "tool-sandbox-image",
      ]
    : commandArguments;
const args = [
  "compose",
  "--env-file",
  environmentFile,
  "--file",
  composeFile,
  ...profileArguments,
  command,
  ...serviceArguments,
];

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn("docker", args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AGENT_DOCK_IMAGE_REVISION: imageRevision,
      AGENT_DOCK_APPLICATION_UID: String(applicationOwner.uid),
      AGENT_DOCK_APPLICATION_GID: String(applicationOwner.gid),
    },
    stdio: "inherit",
  });
  child.once("error", () => rejectPromise(new Error("Docker Compose could not start")));
  child.once("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else {
      rejectPromise(
        new Error(`Docker Compose failed (code=${String(code)}, signal=${String(signal)})`),
      );
    }
  });
});
