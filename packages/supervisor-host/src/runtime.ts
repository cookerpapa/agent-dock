import {
  type CheckpointObjectStore,
  PostgresSandboxCheckpointStore,
} from "@agent-dock/control-plane";
import { createDatabase, type Database } from "@agent-dock/database";
import type { SupervisorBootProvisionRequest } from "@agent-dock/protocol";
import {
  DockerSandboxTurnRunner,
  FileEventSpoolStore,
  LocalSandboxSupervisor,
  ReconnectingSupervisorWebSocketClient,
  type ReconnectingSupervisorWebSocketClientStop,
} from "@agent-dock/sandbox-supervisor";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import { SupervisorBootLedger, type SupervisorHostBootIdentity } from "./boot-ledger.ts";
import type { SupervisorHostConfig } from "./config.ts";
import { SupervisorManagementServer } from "./management-server.ts";
import { SupervisorProvisioningClient } from "./provisioning-client.ts";

export type SupervisorHostRuntimeState =
  "idle" | "starting" | "ready" | "draining" | "stopped" | "failed";

export type SupervisorHostRuntimeOptions = {
  config: SupervisorHostConfig;
  database?: Kysely<Database>;
  objectStore: CheckpointObjectStore & { checkHealth(): Promise<void>; destroy(): void };
  provisioningClient?: SupervisorProvisioningClient;
  idGenerator?: () => string;
  connectionSecretGenerator?: () => string;
};

export type SupervisorHostTerminalReason = "owner_stopped" | "connection_failed";

export class SupervisorHostRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorHostRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

function connectionSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new TypeError("Connection secret generator returned an invalid value");
  }
  return value;
}

function dockerProbe(command: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      ["version", "--format", "{{.Server.Version}}"],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1_024 },
      (error, stdout) => {
        if (error || !/^\d+\.\d+(?:\.\d+)?\s*$/.test(stdout)) {
          rejectPromise(
            new SupervisorHostRuntimeError(
              "docker_unavailable",
              "Docker service is unavailable to the Supervisor host",
              true,
            ),
          );
          return;
        }
        resolvePromise();
      },
    );
  });
}

export class SupervisorHostRuntime {
  readonly #config: SupervisorHostConfig;
  readonly #database: Kysely<Database>;
  readonly #ownsDatabase: boolean;
  readonly #objectStore: CheckpointObjectStore & {
    checkHealth(): Promise<void>;
    destroy(): void;
  };
  readonly #provisioningClient: SupervisorProvisioningClient;
  readonly #idGenerator: () => string;
  readonly #connectionSecretGenerator: () => string;
  readonly #ownerStoppedPromise: Promise<void>;
  readonly #resolveOwnerStopped: () => void;
  readonly #terminalPromise: Promise<SupervisorHostTerminalReason>;
  readonly #resolveTerminal: (reason: SupervisorHostTerminalReason) => void;
  #state: SupervisorHostRuntimeState = "idle";
  #identity: SupervisorHostBootIdentity | undefined;
  #ledger: SupervisorBootLedger | undefined;
  #localSupervisor: LocalSandboxSupervisor | undefined;
  #client: ReconnectingSupervisorWebSocketClient | undefined;
  #managementServer: SupervisorManagementServer | undefined;
  #closing: Promise<void> | undefined;
  #ownerStopSettled = false;
  #terminalSettled = false;

  constructor(options: SupervisorHostRuntimeOptions) {
    this.#config = options.config;
    this.#database =
      options.database ??
      createDatabase({ connectionString: options.config.databaseUrl, maxConnections: 4 });
    this.#ownsDatabase = options.database === undefined;
    this.#objectStore = options.objectStore;
    this.#provisioningClient =
      options.provisioningClient ??
      new SupervisorProvisioningClient({
        baseUrl: options.config.controlPlaneBaseUrl,
        enrollmentToken: options.config.enrollmentToken,
        allowInsecureHttp: options.config.allowInsecureInternalHttp,
      });
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#connectionSecretGenerator =
      options.connectionSecretGenerator ?? (() => randomBytes(32).toString("base64url"));
    let resolveOwnerStopped!: () => void;
    this.#ownerStoppedPromise = new Promise((resolvePromise) => {
      resolveOwnerStopped = resolvePromise;
    });
    this.#resolveOwnerStopped = resolveOwnerStopped;
    let resolveTerminal!: (reason: SupervisorHostTerminalReason) => void;
    this.#terminalPromise = new Promise((resolvePromise) => {
      resolveTerminal = resolvePromise;
    });
    this.#resolveTerminal = resolveTerminal;
  }

  get state(): SupervisorHostRuntimeState {
    return this.#state;
  }

  get identity(): SupervisorHostBootIdentity | undefined {
    return this.#identity === undefined ? undefined : { ...this.#identity };
  }

  waitUntilOwnerStopped(): Promise<void> {
    return this.#ownerStoppedPromise;
  }

  waitUntilTerminal(): Promise<SupervisorHostTerminalReason> {
    return this.#terminalPromise;
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("Supervisor host runtime can only start once");
    this.#state = "starting";
    const identity: SupervisorHostBootIdentity = {
      supervisorId: this.#config.supervisorId,
      bootId: this.#idGenerator(),
      sandboxId: this.#idGenerator(),
    };
    this.#identity = identity;
    const ledger = new SupervisorBootLedger({
      rootDirectory: this.#config.bootStateDirectory,
      supervisorId: identity.supervisorId,
      idGenerator: this.#idGenerator,
    });
    this.#ledger = ledger;
    await ledger.beginBoot(identity);

    let client: ReconnectingSupervisorWebSocketClient | undefined;
    const managementServer = new SupervisorManagementServer({
      host: this.#config.managementHost,
      port: this.#config.managementPort,
      managementToken: this.#config.managementToken,
      identity,
      bootLedger: ledger,
      readiness: () => this.#state === "ready",
      stopCurrentBoot: async () => {
        if (this.#state === "draining" || this.#state === "stopped") return;
        this.#state = "draining";
        client?.setAcceptingAssignments(false);
        await client?.stop();
        this.#localSupervisor?.revokeAllAssignments();
        await this.#localSupervisor?.waitUntilAssignmentsSettled();
        if (!this.#ownerStopSettled) {
          this.#ownerStopSettled = true;
          this.#resolveOwnerStopped();
          this.#settleTerminal("owner_stopped");
        }
      },
      dockerCommand: this.#config.dockerCommand,
      inventoryTimeoutMs: this.#config.dockerProbeTimeoutMs,
    });
    this.#managementServer = managementServer;
    try {
      await managementServer.listen();
      await Promise.all([
        sql`select 1`.execute(this.#database),
        this.#objectStore.checkHealth(),
        dockerProbe(this.#config.dockerCommand, this.#config.dockerProbeTimeoutMs),
      ]);

      const secret = connectionSecret(this.#connectionSecretGenerator());
      const request: SupervisorBootProvisionRequest = {
        protocolVersion: 1,
        type: "supervisor.boot.provision",
        requestId: this.#idGenerator(),
        supervisorId: identity.supervisorId,
        bootId: identity.bootId,
        sandboxId: identity.sandboxId,
        credentialId: this.#idGenerator(),
        credentialSha256: createHash("sha256").update(secret).digest("hex"),
        maxConcurrentSessions: this.#config.maxConcurrentSessions,
      };
      await this.#provisioningClient.provision(request);

      const checkpointStore = new PostgresSandboxCheckpointStore({
        database: this.#database,
        objectStore: this.#objectStore,
      });
      const runner = new DockerSandboxTurnRunner({
        image: this.#config.sandboxImage,
        dockerCommand: this.#config.dockerCommand,
        runtimeIdentity: identity,
        checkpointStore,
        scenario: ({ restoring }) => (restoring ? "java_followup" : "java_repair"),
      });
      const spoolStore = new FileEventSpoolStore({
        rootDirectory: resolve(this.#config.eventSpoolDirectory, identity.bootId),
      });
      const localSupervisor = new LocalSandboxSupervisor({
        runner,
        maxConcurrentSessions: this.#config.maxConcurrentSessions,
        eventSpoolFactory: (options) => spoolStore.open(options),
        eventSpoolRecovery: spoolStore,
      });
      this.#localSupervisor = localSupervisor;
      client = new ReconnectingSupervisorWebSocketClient({
        url: this.#config.supervisorWebSocketUrl,
        authorizationHeader: `Bearer ${request.credentialId}.${secret}`,
        registration: {
          ...identity,
          maxConcurrentSessions: this.#config.maxConcurrentSessions,
        },
        runtime: localSupervisor,
      });
      this.#client = client;
      await client.start();
      this.#state = "ready";
      void client.waitUntilStopped().then((result) => this.#observeClientStop(result));
    } catch (error: unknown) {
      this.#state = "failed";
      await this.close().catch(() => undefined);
      if (error instanceof SupervisorHostRuntimeError) throw error;
      throw new SupervisorHostRuntimeError(
        "supervisor_host_start_failed",
        "Supervisor host failed to start",
        true,
      );
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#state !== "failed") this.#state = "draining";
    this.#client?.setAcceptingAssignments(false);
    await this.#client?.stop().catch(() => undefined);
    this.#localSupervisor?.revokeAllAssignments();
    await this.#localSupervisor?.waitUntilAssignmentsSettled().catch(() => undefined);
    await this.#managementServer?.close().catch(() => undefined);
    this.#objectStore.destroy();
    if (this.#ownsDatabase) await this.#database.destroy();
    if (this.#state !== "failed") this.#state = "stopped";
  }

  #observeClientStop(result: ReconnectingSupervisorWebSocketClientStop): void {
    if (this.#state === "draining" || this.#state === "stopped") return;
    if (result.reason === "terminal_failure") {
      this.#state = "failed";
      this.#settleTerminal("connection_failed");
    }
  }

  #settleTerminal(reason: SupervisorHostTerminalReason): void {
    if (this.#terminalSettled) return;
    this.#terminalSettled = true;
    this.#resolveTerminal(reason);
  }
}
