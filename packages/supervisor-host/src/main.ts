import { createS3CheckpointObjectStoreFromEnvironment } from "@agent-dock/control-plane";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadSupervisorHostConfig } from "./config.ts";
import { SupervisorHostRuntime } from "./runtime.ts";

type StopReason = "sigint" | "sigterm" | "owner_stopped" | "connection_failed";

function signalPromise(): Promise<"sigint" | "sigterm"> {
  return new Promise((resolvePromise) => {
    process.once("SIGINT", () => resolvePromise("sigint"));
    process.once("SIGTERM", () => resolvePromise("sigterm"));
  });
}

export async function startSupervisorHost(): Promise<void> {
  const config = await loadSupervisorHostConfig();
  const objectStore = createS3CheckpointObjectStoreFromEnvironment();
  const runtime = new SupervisorHostRuntime({ config, objectStore });
  try {
    await runtime.start();
    const identity = runtime.identity!;
    process.stdout.write(
      `AgentDock Supervisor host ready supervisor=${identity.supervisorId} boot=${identity.bootId} sandbox=${identity.sandboxId}\n`,
    );
    const reason: StopReason = await Promise.race([runtime.waitUntilTerminal(), signalPromise()]);
    if (reason === "owner_stopped") {
      // Give Fastify a bounded window to flush the owner proof before this
      // process exits and the container runtime starts a fresh boot.
      await delay(250);
    }
    await runtime.close();
    if (reason === "connection_failed") process.exitCode = 1;
  } catch (error: unknown) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startSupervisorHost().catch(() => {
    process.stderr.write("AgentDock Supervisor host failed\n");
    process.exitCode = 1;
  });
}
