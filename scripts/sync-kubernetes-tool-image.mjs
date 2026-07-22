import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const images = [
  process.env.AGENT_DOCK_TOOL_SANDBOX_IMAGE ??
    `agent-dock/tool-sandbox:${process.env.AGENT_DOCK_IMAGE_VERSION ?? "production"}`,
  process.env.AGENT_DOCK_DEPENDENCY_EGRESS_IMAGE ??
    `agent-dock/dependency-egress-proxy:${process.env.AGENT_DOCK_IMAGE_VERSION ?? "production"}`,
];
if (images.some((image) => !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,511}$/.test(image))) {
  throw new Error("Kubernetes execution-plane image reference is invalid");
}

function containerdReference(value) {
  const slash = value.indexOf("/");
  if (slash === -1) return `docker.io/library/${value}`;
  const first = value.slice(0, slash);
  return first.includes(".") || first.includes(":") || first === "localhost"
    ? value
    : `docker.io/${value}`;
}

function capture(command, args, timeout = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024, timeout },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(`${command} failed: ${stderr.trim()}`));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`),
        );
    });
  });
}

const directory = await mkdtemp(join(tmpdir(), "agent-dock-k3s-image-"));
try {
  const results = [];
  for (const [index, image] of images.entries()) {
    const dockerImageId = await capture("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image,
    ]);
    if (!/^sha256:[a-f0-9]{64}$/.test(dockerImageId)) {
      throw new Error("An exact execution-plane Docker image is unavailable");
    }
    const archive = join(directory, `execution-plane-${String(index)}.tar`);
    await run("docker", ["image", "save", "--output", archive, image]);
    await run("ctr", [
      "--address",
      "/run/k3s/containerd/containerd.sock",
      "--namespace",
      "k8s.io",
      "images",
      "import",
      "--all-platforms",
      archive,
    ]);
    const imported = await capture("ctr", [
      "--address",
      "/run/k3s/containerd/containerd.sock",
      "--namespace",
      "k8s.io",
      "images",
      "list",
      "--quiet",
    ]);
    const importedReferences = imported.split(/\r?\n/);
    const runtimeImage = containerdReference(image);
    if (!importedReferences.includes(image) && !importedReferences.includes(runtimeImage)) {
      throw new Error("K3s containerd did not retain an execution-plane image reference");
    }
    results.push({ image, runtimeImage, dockerImageId, imported: true });
  }
  process.stdout.write(`${JSON.stringify({ images: results })}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
