import { execFile, spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";

const containerdAddress = "/run/k3s/containerd/containerd.sock";
const k3sImageDirectory = "/var/lib/rancher/k3s/agent/images";
const archivePath = `${k3sImageDirectory}/pi-cloud-cubesandbox-v0.6.0.tar`;
const partialArchivePath = `${archivePath}.partial`;
const images = [
  "busybox:1.36",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/alpine-k8s:1.28.15",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-api:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-egress-net:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-egress:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-guest:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-kernel:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-lifecycle-manager:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-master:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-node-init:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-proxy:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-shim:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-wait-node-prep:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cubelet:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cubemastercli:v0.6.0",
  "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/network-agent:v0.6.0",
  "curlimages/curl:8.10.1",
  "mysql:8.0",
  "redis:7-alpine",
  "registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
];

function canonicalImageReference(image) {
  const [name, digest] = image.split("@", 2);
  const segments = name.split("/");
  const qualified =
    segments.length === 1
      ? `docker.io/library/${name}`
      : !segments[0].includes(".") && !segments[0].includes(":") && segments[0] !== "localhost"
        ? `docker.io/${name}`
        : name;
  return digest === undefined ? qualified : `${qualified}@${digest}`;
}

if (process.getuid?.() !== 0) {
  throw new Error("CubeSandbox image prefetch must run as root to access K3s containerd");
}

function capture(command, args, timeout = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024, timeout },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(`${command} failed: ${stderr.trim() || error.message}`));
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
      else {
        rejectPromise(
          new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
  });
}

async function pullWithRetry(image) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await run("docker", ["pull", image]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        process.stdout.write(`pull retry ${String(attempt)}/5 for ${image}\n`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

async function dockerImageExists(image) {
  return capture("docker", ["image", "inspect", image])
    .then(() => true)
    .catch(() => false);
}

async function waitForImportedImages(timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const imported = new Set(
      (
        await capture("ctr", [
          "--address",
          containerdAddress,
          "--namespace",
          "k8s.io",
          "images",
          "list",
          "--quiet",
        ])
      ).split(/\r?\n/),
    );
    if (images.every((image) => imported.has(canonicalImageReference(image)))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("K3s did not finish importing the pinned CubeSandbox image archive");
}

const existing = new Set(
  (
    await capture("ctr", [
      "--address",
      containerdAddress,
      "--namespace",
      "k8s.io",
      "images",
      "list",
      "--quiet",
    ])
  ).split(/\r?\n/),
);
const results = [];
try {
  for (const [index, image] of images.entries()) {
    const local = await dockerImageExists(image);
    if (!local) {
      process.stdout.write(`[${index + 1}/${images.length}] pulling ${image}\n`);
      await pullWithRetry(image);
    } else {
      process.stdout.write(`[${index + 1}/${images.length}] available locally ${image}\n`);
    }
    results.push({
      image,
      imported: true,
      reused: existing.has(canonicalImageReference(image)),
    });
  }
  await mkdir(k3sImageDirectory, { recursive: true, mode: 0o700 });
  await rm(partialArchivePath, { force: true });
  await run("docker", ["image", "save", "--output", partialArchivePath, ...images]);
  await rename(partialArchivePath, archivePath);
  await waitForImportedImages();
} finally {
  await rm(partialArchivePath, { force: true });
}

process.stdout.write(`${JSON.stringify({ images: results, pinnedArchive: archivePath })}\n`);
