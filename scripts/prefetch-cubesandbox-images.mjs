import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const containerdAddress = "/run/k3s/containerd/containerd.sock";
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
const directory = await mkdtemp(join(tmpdir(), "agent-dock-cube-images-"));
const results = [];
try {
  for (const [index, image] of images.entries()) {
    if (existing.has(image)) {
      process.stdout.write(`[${index + 1}/${images.length}] already imported ${image}\n`);
      results.push({ image, imported: true, reused: true });
      continue;
    }
    process.stdout.write(`[${index + 1}/${images.length}] pulling ${image}\n`);
    await pullWithRetry(image);
    const archive = join(directory, `cube-${String(index)}.tar`);
    await run("docker", ["image", "save", "--output", archive, image]);
    await run("ctr", [
      "--address",
      containerdAddress,
      "--namespace",
      "k8s.io",
      "images",
      "import",
      archive,
    ]);
    await rm(archive, { force: true });
    results.push({ image, imported: true, reused: false });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ images: results })}\n`);
