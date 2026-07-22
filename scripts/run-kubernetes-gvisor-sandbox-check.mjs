import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image = process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE ?? "agent-dock/tool-sandbox:provider-check";
const dependencyEgressImage =
  process.env.AGENT_DOCK_DEPENDENCY_EGRESS_IMAGE ?? "agent-dock/dependency-egress-proxy:production";
const kubeconfigPath = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_KUBECONFIG_PATH ??
    "deploy/production/runtime/kubernetes/sandbox-manager.kubeconfig",
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const executionEnvironment = {
  ...process.env,
  NO_PROXY: [process.env.NO_PROXY, "agent-dock-kubernetes", "127.0.0.1"].filter(Boolean).join(","),
};

function capture(command, args, timeout = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: executionEnvironment,
        encoding: "utf8",
        maxBuffer: 4 * 1_024 * 1_024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(`${command} failed: ${stderr.trim()}`));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function captureOutcome(command, args, timeout = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: executionEnvironment,
        encoding: "utf8",
        maxBuffer: 4 * 1_024 * 1_024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") rejectPromise(error);
        else {
          resolvePromise({
            code: error && typeof error.code === "number" ? error.code : 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        }
      },
    );
  });
}

function run(command, args, environment = executionEnvironment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `${command} ${args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
    });
  });
}

if (process.platform !== "linux") {
  throw new Error("The Kubernetes gVisor gate requires a native Linux execution node.");
}
await access(kubeconfigPath);
const clusterVersion = await capture("kubectl", [
  "--kubeconfig",
  kubeconfigPath,
  "version",
  "--output=json",
]);
const runtimeClass = JSON.parse(
  await capture("kubectl", [
    "--kubeconfig",
    kubeconfigPath,
    "get",
    "runtimeclass",
    "agent-dock-gvisor",
    "--output=json",
  ]),
);
if (
  runtimeClass?.handler !== "runsc" ||
  runtimeClass?.metadata?.annotations?.["agent-dock.io/runtime"] !== "runsc" ||
  runtimeClass?.metadata?.annotations?.["agent-dock.io/platform"] !== "kvm"
) {
  throw new Error("The scoped Kubernetes API did not expose the fixed runsc/KVM RuntimeClass.");
}
const namespaces = ["agent-dock-sandboxes", "agent-dock-importers"];
for (const namespace of namespaces) {
  const allowed = await capture("kubectl", [
    "--kubeconfig",
    kubeconfigPath,
    "auth",
    "can-i",
    "create",
    "pods",
    "--namespace",
    namespace,
  ]);
  if (allowed !== "yes") throw new Error(`Sandbox Manager cannot create Pods in ${namespace}.`);
}
const secretsAllowed = await captureOutcome("kubectl", [
  "--kubeconfig",
  kubeconfigPath,
  "auth",
  "can-i",
  "get",
  "secrets",
  "--namespace",
  "agent-dock-sandboxes",
]);
if (secretsAllowed.stdout !== "no" || secretsAllowed.code !== 1) {
  throw new Error("Sandbox Manager unexpectedly has Secret access.");
}
const runtimeClassListAllowed = await captureOutcome("kubectl", [
  "--kubeconfig",
  kubeconfigPath,
  "auth",
  "can-i",
  "list",
  "runtimeclasses.node.k8s.io",
]);
if (runtimeClassListAllowed.stdout !== "no" || runtimeClassListAllowed.code !== 1) {
  throw new Error("Sandbox Manager unexpectedly has RuntimeClass inventory access.");
}
const dependencyTrustAllowed = await capture("kubectl", [
  "--kubeconfig",
  kubeconfigPath,
  "auth",
  "can-i",
  "patch",
  "configmaps/dependency-egress-trust",
  "--namespace",
  "agent-dock-egress",
]);
if (dependencyTrustAllowed !== "yes") {
  throw new Error("Sandbox Manager cannot publish the dependency egress public trust anchor.");
}

const buildArguments = [];
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
  const value = process.env[name];
  if (value !== undefined) {
    if (value.length > 2_048 || /[\r\n\0]/.test(value)) {
      throw new Error(`${name} is not a bounded build proxy value.`);
    }
    buildArguments.push("--build-arg", `${name}=${value}`);
  }
}
await run("docker", [
  "build",
  "--network",
  "host",
  ...buildArguments,
  "--file",
  "packages/tool-sandbox/Dockerfile",
  "--tag",
  image,
  ".",
]);
await run("docker", [
  "build",
  "--network",
  "none",
  "--file",
  "packages/dependency-egress-proxy/Dockerfile",
  "--tag",
  dependencyEgressImage,
  ".",
]);
const issuerDirectory = await mkdtemp(join(tmpdir(), "agent-dock-egress-issuer-"));
const issuerPath = join(issuerDirectory, "private-key.pem");
const { privateKey } = generateKeyPairSync("ed25519");
await writeFile(issuerPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
await chmod(issuerPath, 0o600);
const testEnvironment = {
  ...executionEnvironment,
  AGENT_DOCK_KUBECONFIG_PATH: kubeconfigPath,
  AGENT_DOCK_TOOL_SANDBOX_IMAGE: image,
  AGENT_DOCK_DEPENDENCY_EGRESS_IMAGE: dependencyEgressImage,
  AGENT_DOCK_DEPENDENCY_EGRESS_PRIVATE_KEY_FILE: issuerPath,
};
await run(process.execPath, ["scripts/sync-kubernetes-tool-image.mjs"], testEnvironment);
process.stdout.write(
  `${JSON.stringify({ cluster: JSON.parse(clusterVersion), runtimeClass: runtimeClass.metadata.name, image })}\n`,
);

try {
  await run(
    npmCommand,
    [
      "exec",
      "--workspace",
      "@agent-dock/sandbox-manager",
      "--",
      "vitest",
      "--run",
      "test/gvisor-sandbox-provider.integration.test.ts",
    ],
    { ...testEnvironment, AGENT_DOCK_KUBERNETES_GVISOR_TEST: "1" },
  );
  await run(
    npmCommand,
    [
      "exec",
      "--workspace",
      "@agent-dock/sandbox-supervisor",
      "--",
      "vitest",
      "--run",
      "test/remote-tool-sandbox-turn-runner.integration.test.ts",
    ],
    { ...testEnvironment, AGENT_DOCK_REMOTE_TOOL_SANDBOX_TEST: "1" },
  );
} finally {
  await rm(issuerDirectory, { recursive: true, force: true });
}

for (const namespace of namespaces) {
  const remaining = await capture("kubectl", [
    "--kubeconfig",
    kubeconfigPath,
    "get",
    "pods",
    "--namespace",
    namespace,
    "--selector",
    "agent-dock.io/managed=true",
    "--output=name",
  ]);
  if (remaining.length > 0) {
    throw new Error(`The Kubernetes gVisor gate left a managed Pod in ${namespace}.`);
  }
}
process.stdout.write("kubernetes_gvisor_sandbox_check_passed\n");
