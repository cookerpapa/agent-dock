import { createS3CheckpointObjectStoreFromEnvironment } from "@agent-dock/control-plane/checkpoint-runtime";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadSupervisorHostConfig } from "./config.ts";
import { SupervisorHostRuntime } from "./runtime.ts";

type StopReason = "sigint" | "sigterm" | "owner_stopped" | "connection_failed";

function safeFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof TypeError) return "invalid_supervisor_configuration";
  return "supervisor_host_start_failed";
}

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
    if (reason === "connection_failed") {
      process.stderr.write(
        `AgentDock Supervisor host failed code=${runtime.terminalFailureCode ?? "supervisor_connection_failed"}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startSupervisorHost().catch((error: unknown) => {
    process.stderr.write(`AgentDock Supervisor host failed code=${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
