import {
  type CheckpointObjectStore,
  PostgresSandboxCheckpointStore,
} from "@agent-dock/control-plane/checkpoint-runtime";
import {
  PostgresTenantModelCredentialResolver,
  TenantModelCredentialVault,
} from "@agent-dock/control-plane/model-credential-runtime";
import { PostgresRunAttemptPhaseObserver } from "@agent-dock/control-plane/run-attempt-runtime";
import { createDatabase, type Database } from "@agent-dock/database";
import { GitHubGatewayClient } from "@agent-dock/github-gateway";
import type { AgentDockMetrics } from "@agent-dock/observability";
import type { SupervisorBootProvisionRequest } from "@agent-dock/protocol";
import { SandboxManagerClient } from "@agent-dock/sandbox-manager";
import {
  FileEventSpoolStore,
  LocalSandboxSupervisor,
  RemoteToolSandboxTurnRunner,
  ReconnectingSupervisorWebSocketClient,
  type PiSdkIsolationFailure,
  type AgentTurnScenario,
  type AgentTurnScenarioContext,
  type ReconnectingSupervisorWebSocketClientStop,
} from "@agent-dock/sandbox-supervisor";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import { SupervisorBootLedger, type SupervisorHostBootIdentity } from "./boot-ledger.ts";
import type { SupervisorHostConfig } from "./config.ts";
import { SupervisorManagementServer } from "./management-server.ts";
import { TenantModelGateway } from "./model-gateway.ts";
import { SupervisorProvisioningClient } from "./provisioning-client.ts";
import { GatewayGitHubWorkspaceImporter, PostgresWorkspaceSeedResolver } from "./workspace-seed.ts";

export type SupervisorHostRuntimeState =
  "idle" | "starting" | "ready" | "draining" | "stopped" | "failed";

export type SupervisorHostRuntimeOptions = {
  config: SupervisorHostConfig;
  database?: Kysely<Database>;
  objectStore: CheckpointObjectStore & { checkHealth(): Promise<void>; destroy(): void };
  provisioningClient?: SupervisorProvisioningClient;
  sandboxManager?: SupervisorSandboxManager;
  idGenerator?: () => string;
  connectionSecretGenerator?: () => string;
  metrics?: AgentDockMetrics;
};

export type SupervisorSandboxManager = Pick<
  SandboxManagerClient,
  | "operationUrl"
  | "checkHealth"
  | "create"
  | "capture"
  | "release"
  | "stop"
  | "importGitHub"
  | "listAssignments"
  | "terminateAndConfirmAbsent"
  | "confirmAbsent"
>;

export type SupervisorHostTerminalReason = "owner_stopped" | "connection_failed";

export const PRODUCTION_CANCELLATION_PROBE_PROMPT = "agent-dock://acceptance/cancellation-hold";

export function resolveProductionSandboxScenario({
  command,
  restoring,
}: AgentTurnScenarioContext): AgentTurnScenario {
  if (restoring) return "java_followup";
  if (
    command.payload.input.kind === "prompt" &&
    command.payload.input.text.startsWith("agent-dock-eval://")
  ) {
    return "coding_eval";
  }
  if (
    command.payload.input.kind === "prompt" &&
    command.payload.input.text === PRODUCTION_CANCELLATION_PROBE_PROMPT
  ) {
    return "tool_hold";
  }
  return "java_repair";
}

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

export class SupervisorHostRuntime {
  readonly #config: SupervisorHostConfig;
  readonly #database: Kysely<Database>;
  readonly #ownsDatabase: boolean;
  readonly #objectStore: CheckpointObjectStore & {
    checkHealth(): Promise<void>;
    destroy(): void;
  };
  readonly #provisioningClient: SupervisorProvisioningClient;
  readonly #sandboxManager: SupervisorSandboxManager;
  readonly #idGenerator: () => string;
  readonly #connectionSecretGenerator: () => string;
  readonly #metrics: AgentDockMetrics | undefined;
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
  #modelGateway: TenantModelGateway | undefined;
  #closing: Promise<void> | undefined;
  #ownerStopSettled = false;
  #terminalSettled = false;
  #terminalFailureCode: string | undefined;

  constructor(options: SupervisorHostRuntimeOptions) {
    if (
      options.config.piExecutionMode === "embedded-sdk" &&
      options.config.maxConcurrentSessions !== 1
    ) {
      throw new TypeError("Embedded Pi SDK Workers require exactly one concurrent Session");
    }
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
    this.#sandboxManager =
      options.sandboxManager ??
      new SandboxManagerClient({
        baseUrl: options.config.sandboxManagerBaseUrl,
        serviceToken: options.config.sandboxManagerServiceToken,
        allowInsecureHttp: options.config.allowInsecureInternalHttp,
        requestTimeoutMs: options.config.sandboxManagerRequestTimeoutMs,
      });
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#connectionSecretGenerator =
      options.connectionSecretGenerator ?? (() => randomBytes(32).toString("base64url"));
    this.#metrics = options.metrics;
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

  get terminalFailureCode(): string | undefined {
    return this.#terminalFailureCode;
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
      readiness: () => this.#state === "ready" && client?.state === "connected",
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
      assignmentInventory: this.#sandboxManager,
      artifactStore: this.#objectStore,
    });
    this.#managementServer = managementServer;
    try {
      await managementServer.listen();
      await Promise.all([
        sql`select 1`.execute(this.#database),
        this.#objectStore.checkHealth(),
        this.#sandboxManager.checkHealth(),
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
        managementBaseUrl: this.#config.managementAdvertisedBaseUrl,
      };
      await this.#provisioningClient.provision(request);

      const checkpointStore = new PostgresSandboxCheckpointStore({
        database: this.#database,
        objectStore: this.#objectStore,
      });
      const githubGateway =
        this.#config.githubGatewayBaseUrl === undefined ||
        this.#config.githubGatewayServiceToken === undefined
          ? undefined
          : new GitHubGatewayClient({
              baseUrl: this.#config.githubGatewayBaseUrl,
              serviceToken: this.#config.githubGatewayServiceToken,
              allowInsecureHttp: this.#config.allowInsecureInternalHttp,
            });
      const workspaceSeedResolver = new PostgresWorkspaceSeedResolver({
        database: this.#database,
        objectStore: this.#objectStore,
        importer: {
          import: (source, signal) => this.#sandboxManager.importGitHub(source, signal),
        },
        ...(githubGateway === undefined
          ? {}
          : { privateImporter: new GatewayGitHubWorkspaceImporter(githubGateway) }),
        importLeaseMs: this.#config.repositoryImportLeaseMs,
        maximumWaitMs: this.#config.repositoryImportWaitMs,
      });
      const modelGateway = new TenantModelGateway({
        database: this.#database,
        credentialResolver: new PostgresTenantModelCredentialResolver({
          database: this.#database,
          vault: new TenantModelCredentialVault(this.#config.modelCredentialMasterKey),
        }),
        host: this.#config.modelGatewayHost,
        port: this.#config.modelGatewayPort,
        advertisedBaseUrl: this.#config.modelGatewayAdvertisedBaseUrl,
        capabilityTtlMs: this.#config.modelGatewayCapabilityTtlMs,
        maximumRequestsPerTurn: this.#config.modelGatewayMaximumRequestsPerTurn,
        upstreamRequestTimeoutMs: this.#config.modelGatewayUpstreamRequestTimeoutMs,
        piRequestTimeoutMs: this.#config.piModelRequestTimeoutMs,
        piTurnTimeoutMs: this.#config.piTurnTimeoutMs,
        ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
      });
      await modelGateway.start();
      this.#modelGateway = modelGateway;
      const runner = new RemoteToolSandboxTurnRunner({
        manager: this.#sandboxManager,
        runtimeIdentity: identity,
        trustedWorkspaceDirectory: this.#config.trustedWorkspaceDirectory,
        checkpointStore,
        runAttemptPhaseObserver: new PostgresRunAttemptPhaseObserver({
          database: this.#database,
        }),
        scenario: resolveProductionSandboxScenario,
        modelRuntimeLeaseResolver: (command) => modelGateway.issue(command),
        workspaceSeedResolver: (command, signal) => workspaceSeedResolver.resolve(command, signal),
        turnTimeoutMs: this.#config.piTurnTimeoutMs,
        piExecutionMode: this.#config.piExecutionMode,
        onPiSdkIsolationFailure: (error) => this.#retireForPiSdkIsolationFailure(error),
        ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
      });
      const spoolStore = new FileEventSpoolStore({
        rootDirectory: resolve(this.#config.eventSpoolDirectory, "active", identity.bootId),
        quarantineDirectory: resolve(
          this.#config.eventSpoolDirectory,
          "quarantine",
          identity.bootId,
        ),
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
    await this.#modelGateway?.close().catch(() => undefined);
    this.#objectStore.destroy();
    if (this.#ownsDatabase) await this.#database.destroy();
    if (this.#state !== "failed") this.#state = "stopped";
  }

  #observeClientStop(result: ReconnectingSupervisorWebSocketClientStop): void {
    if (this.#state === "draining" || this.#state === "stopped") return;
    if (result.reason === "terminal_failure") {
      this.#terminalFailureCode = result.failureCode ?? "supervisor_connection_failed";
      this.#state = "failed";
      this.#settleTerminal("connection_failed");
    }
  }

  #retireForPiSdkIsolationFailure(error: PiSdkIsolationFailure): void {
    if (this.#state === "draining" || this.#state === "stopped") return;
    this.#terminalFailureCode = error.code;
    this.#state = "failed";
    this.#client?.setAcceptingAssignments(false);
    this.#settleTerminal("connection_failed");
  }

  #settleTerminal(reason: SupervisorHostTerminalReason): void {
    if (this.#terminalSettled) return;
    this.#terminalSettled = true;
    this.#resolveTerminal(reason);
  }
}
