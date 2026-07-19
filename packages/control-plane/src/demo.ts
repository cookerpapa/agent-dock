import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@agent-dock/database";
import {
  DockerSandboxTurnRunner,
  FileEventSpoolStore,
  LocalSandboxSupervisor,
} from "@agent-dock/sandbox-supervisor";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createControlPlaneApplication } from "./application.ts";
import { CancellationDispatcher } from "./cancellation-dispatcher.ts";
import { FileCheckpointObjectStore, PostgresSandboxCheckpointStore } from "./checkpoint-store.ts";
import { DurableEventStore } from "./durable-event-store.ts";
import { LocalSupervisorExecutionBackend } from "./local-supervisor-execution-backend.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { SessionLeaseCoordinator } from "./session-lease-coordinator.ts";

const DEMO_IDS = {
  tenant: "01000000-0000-4000-8000-000000000001",
  credential: "02000000-0000-4000-8000-000000000001",
  profile: "03000000-0000-4000-8000-000000000001",
  sandbox: "04000000-0000-4000-8000-000000000001",
  sandboxBoot: "05000000-0000-4000-8000-000000000001",
} as const;

const DEFAULT_PORT = 3_100;
const IDLE_POLL_MS = 60;
const FAILURE_POLL_MS = 400;

type DispatchResult = { status: string };

export type DemoRuntime = {
  url: string;
  close(): Promise<void>;
};

export type DemoRuntimeOptions = {
  port?: number;
  image?: string;
  dockerCommand?: string;
  checkpointDirectory?: string;
  eventSpoolDirectory?: string;
};

function demoPort(): number {
  const raw = process.env.AGENT_DOCK_DEMO_API_PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AGENT_DOCK_DEMO_API_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function runtimePort(value: number | undefined): number {
  if (value === undefined) return demoPort();
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("demo runtime port must be an integer between 0 and 65535");
  }
  return value;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    const onAbort = (): void => settle();
    function settle(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function dispatchLoop(
  name: "execution" | "cancellation",
  dispatch: () => Promise<DispatchResult>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await dispatch();
      if (result.status === "idle") {
        await wait(IDLE_POLL_MS, signal);
      } else {
        process.stdout.write(
          `${JSON.stringify({ component: `${name}-dispatcher`, status: result.status })}\n`,
        );
      }
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      process.stderr.write(
        `${JSON.stringify({ component: `${name}-dispatcher`, status: "error", errorName })}\n`,
      );
      await wait(FAILURE_POLL_MS, signal);
    }
  }
}

async function seedDemoRuntime(database: ReturnType<typeof createDatabase>): Promise<void> {
  await database
    .insertInto("tenants")
    .values({ id: DEMO_IDS.tenant, slug: "local-demo" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("credential_bindings")
    .values({
      id: DEMO_IDS.credential,
      tenant_id: DEMO_IDS.tenant,
      provider: "agent-dock-fake",
      kind: "api_key",
      secret_ref: "demo://embedded-fake-model",
      version: 1,
      status: "active",
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("model_profiles")
    .values({
      id: DEMO_IDS.profile,
      tenant_id: DEMO_IDS.tenant,
      name: "zero-token-java-repair",
      provider: "agent-dock-fake",
      model_id: "embedded-java-repair",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: DEMO_IDS.credential,
      credential_binding_version: 1,
      enabled: true,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sandboxes")
    .values({
      id: DEMO_IDS.sandbox,
      supervisor_id: "local-docker-demo",
      boot_id: DEMO_IDS.sandboxBoot,
      state: "ready",
      max_concurrent_sessions: 1,
      active_sessions: 0,
    })
    .executeTakeFirstOrThrow();
}

export async function startDemoRuntime(options: DemoRuntimeOptions = {}): Promise<DemoRuntime> {
  const configuredCheckpointDirectory =
    options.checkpointDirectory ?? process.env.AGENT_DOCK_DEMO_CHECKPOINT_DIR;
  const checkpointDirectory = configuredCheckpointDirectory
    ? resolve(configuredCheckpointDirectory)
    : await mkdtemp(resolve(tmpdir(), "agent-dock-demo-checkpoints-"));
  const removeCheckpointDirectory = configuredCheckpointDirectory === undefined;
  const configuredEventSpoolDirectory =
    options.eventSpoolDirectory ?? process.env.AGENT_DOCK_DEMO_EVENT_SPOOL_DIR;
  const eventSpoolDirectory = configuredEventSpoolDirectory
    ? resolve(configuredEventSpoolDirectory)
    : await mkdtemp(resolve(tmpdir(), "agent-dock-demo-event-spool-"));
  const removeEventSpoolDirectory = configuredEventSpoolDirectory === undefined;
  const pglite = await PGlite.create();
  const socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 8,
  });
  let database: ReturnType<typeof createDatabase> | undefined;
  let application: Awaited<ReturnType<typeof createControlPlaneApplication>> | undefined;
  const stopController = new AbortController();
  let loops: readonly Promise<void>[] = [];
  let closing: Promise<void> | undefined;

  try {
    await socketServer.start();
    database = createDatabase({
      connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 6,
    });
    await runMigrations(database, "up");
    await seedDemoRuntime(database);

    application = await createControlPlaneApplication({
      database,
      tenantId: DEMO_IDS.tenant,
      defaultModelProfileId: DEMO_IDS.profile,
    });
    const leaseCoordinator = new SessionLeaseCoordinator({
      database,
      sandboxId: DEMO_IDS.sandbox,
      leaseDurationMs: 120_000,
    });
    const checkpointStore = new PostgresSandboxCheckpointStore({
      database,
      objectStore: new FileCheckpointObjectStore({ rootDirectory: checkpointDirectory }),
    });
    const eventSpoolStore = new FileEventSpoolStore({ rootDirectory: eventSpoolDirectory });
    const runner = new DockerSandboxTurnRunner({
      image:
        options.image ?? process.env.AGENT_DOCK_DOCKER_IMAGE ?? "agent-dock/pi-workspace:phase2",
      runtimeIdentity: {
        supervisorId: "local-docker-demo",
        bootId: DEMO_IDS.sandboxBoot,
        sandboxId: DEMO_IDS.sandbox,
      },
      dockerCommand: options.dockerCommand ?? process.env.AGENT_DOCK_DOCKER_COMMAND ?? "docker",
      scenario: ({ restoring }) => (restoring ? "java_followup" : "java_repair"),
      checkpointStore,
      executionTimeoutMs: 60_000,
    });
    const supervisor = new LocalSandboxSupervisor({
      runner,
      eventSpoolFactory: (spoolOptions) => eventSpoolStore.open(spoolOptions),
      eventSpoolRecovery: eventSpoolStore,
      maxConcurrentSessions: 1,
    });
    await supervisor.recoverPendingEvents((message) =>
      application!.get(DurableEventStore).ingest(message),
    );
    const backend = new LocalSupervisorExecutionBackend({
      supervisor,
      leaseCoordinator,
      eventIngestor: application.get(DurableEventStore),
    });
    const executionDispatcher = new OutboxDispatcher({
      database,
      tenantId: DEMO_IDS.tenant,
      backend,
      leaseManager: leaseCoordinator,
    });
    const cancellationDispatcher = new CancellationDispatcher({
      database,
      tenantId: DEMO_IDS.tenant,
      backend,
      leaseManager: leaseCoordinator,
    });

    await application.listen(runtimePort(options.port), "127.0.0.1");
    loops = [
      dispatchLoop("execution", () => executionDispatcher.dispatchNext(), stopController.signal),
      dispatchLoop(
        "cancellation",
        () => cancellationDispatcher.dispatchNext(),
        stopController.signal,
      ),
    ];
    const url = await application.getUrl();

    return {
      url,
      close() {
        closing ??= (async () => {
          stopController.abort();
          await application?.close();
          await Promise.allSettled(loops);
          await database?.destroy();
          await socketServer.stop();
          await pglite.close();
          if (removeCheckpointDirectory) {
            await rm(checkpointDirectory, { recursive: true, force: true });
          }
          if (removeEventSpoolDirectory) {
            await rm(eventSpoolDirectory, { recursive: true, force: true });
          }
        })();
        return closing;
      },
    };
  } catch (error: unknown) {
    stopController.abort();
    await application?.close().catch(() => undefined);
    await Promise.allSettled(loops);
    await database?.destroy().catch(() => undefined);
    await socketServer.stop().catch(() => undefined);
    await pglite.close().catch(() => undefined);
    if (removeCheckpointDirectory) {
      await rm(checkpointDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (removeEventSpoolDirectory) {
      await rm(eventSpoolDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function runDemoRuntime(): Promise<void> {
  const runtime = await startDemoRuntime();
  process.stdout.write(`AgentDock demo control plane listening at ${runtime.url}\n`);
  let closing = false;
  const closeAfterSignal = (): void => {
    if (closing) return;
    closing = true;
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", closeAfterSignal);
  process.once("SIGTERM", closeAfterSignal);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runDemoRuntime().catch(() => {
    process.stderr.write("AgentDock demo control plane failed to start\n");
    process.exitCode = 1;
  });
}
