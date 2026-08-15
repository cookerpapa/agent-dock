import type { Database } from "@agent-dock/database";
import {
  MAX_WORKSPACE_TERMINAL_FRAME_BYTES,
  TOOL_BROKER_TERMINAL_PATH,
  parseEnvironmentRuntimeSnapshot,
  parseUuidPathParameter,
  parseWorkspaceTerminalClientFrame,
  parseWorkspaceTerminalServerFrame,
  type WorkspaceTerminalOpenRequest,
} from "@agent-dock/protocol";
import {
  createWorkspaceSnapshot,
  encodeWorkspaceSnapshotBlob,
} from "@agent-dock/workspace-runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { tenantRequestIdentity } from "./tenant-identity.ts";

export const WORKSPACE_TERMINAL_PATH = "/v1/conversations/:sessionId/terminal";
const MAXIMUM_BUFFERED_BYTES = 1 * 1_024 * 1_024;
const MAXIMUM_REDIRECTS = 3;

export type WorkspaceTerminalGatewayOptions = Readonly<{
  database: Kysely<Database>;
  checkpointReader: { get(objectKey: string): Promise<Uint8Array> };
  terminalToken: string;
  allowInsecureInternalHttp: boolean;
}>;

type TerminalDescriptor = Readonly<{
  domainId: string;
  toolBrokerBaseUrl: string;
  open: WorkspaceTerminalOpenRequest;
}>;

function internalWebSocketUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = TOOL_BROKER_TERMINAL_PATH;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function textFrame(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function send(socket: WebSocket, value: unknown): Promise<void> {
  if (socket.readyState !== socket.OPEN) return Promise.resolve();
  const payload = JSON.stringify(value);
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > MAXIMUM_BUFFERED_BYTES || socket.bufferedAmount + bytes > MAXIMUM_BUFFERED_BYTES) {
    socket.close(4_002, "terminal proxy buffer overloaded");
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    socket.send(payload, (error) => (error ? reject(error) : resolve()));
  });
}

export class WorkspaceTerminalGateway {
  readonly #database: Kysely<Database>;
  readonly #checkpointReader: WorkspaceTerminalGatewayOptions["checkpointReader"];
  readonly #terminalToken: string;
  readonly #allowInsecureInternalHttp: boolean;
  #installed = false;

  constructor(options: WorkspaceTerminalGatewayOptions) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.terminalToken)) {
      throw new TypeError("Workspace terminal gateway token is invalid");
    }
    this.#database = options.database;
    this.#checkpointReader = options.checkpointReader;
    this.#terminalToken = options.terminalToken;
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Workspace terminal gateway is already installed");
    this.#installed = true;
    // The production application queues @fastify/websocket registration before
    // this gateway. Put the route in a subsequent plugin scope so Avvio first
    // installs the WebSocket route decorator; registering it directly on the
    // parent would make Fastify treat it as an ordinary HTTP handler.
    fastify.register(async (scope) => {
      scope.get(WORKSPACE_TERMINAL_PATH, { websocket: true }, (socket, request) => {
        const identity = tenantRequestIdentity(request);
        if (identity === undefined || identity.role === "viewer") {
          socket.close(1_008, "workspace terminal is not authorized");
          return;
        }
        let sessionId: string;
        try {
          sessionId = parseUuidPathParameter(
            (request.params as { sessionId?: unknown }).sessionId,
            "sessionId",
          );
        } catch {
          socket.close(1_008, "workspace terminal session is invalid");
          return;
        }
        void this.#proxy(socket, request, {
          tenantId: identity.tenantId,
          userId: identity.userId,
          sessionId,
        });
      });
    });
  }

  async #proxy(
    browser: WebSocket,
    _request: FastifyRequest,
    identity: Readonly<{ tenantId: string; userId: string; sessionId: string }>,
  ): Promise<void> {
    let upstream: WebSocket | undefined;
    let closed = false;
    let ready = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      const currentUpstream = upstream;
      if (currentUpstream?.readyState === WebSocket.OPEN) {
        void send(currentUpstream, {
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.close",
        }).finally(() => currentUpstream.close(1_000, "browser disconnected"));
      } else if (currentUpstream !== undefined && currentUpstream.readyState !== WebSocket.CLOSED) {
        currentUpstream.terminate();
      }
      if (browser.readyState === browser.OPEN) browser.close(1_000, "terminal closed");
    };
    browser.once("close", close);
    browser.once("error", close);
    let descriptor: TerminalDescriptor;
    try {
      descriptor = await this.#descriptor(identity);
    } catch {
      if (closed) return;
      await send(browser, {
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.error",
        code: "workspace_terminal_unavailable",
        message: "Workspace terminal could not resolve the current Session",
        retryable: true,
      });
      browser.close(1_011, "workspace terminal unavailable");
      return;
    }
    if (closed) return;
    browser.on("message", (data: RawData) => {
      try {
        const frame = parseWorkspaceTerminalClientFrame(JSON.parse(textFrame(data)) as unknown);
        if (!ready || upstream === undefined || upstream.readyState !== upstream.OPEN) {
          throw new Error("terminal not ready");
        }
        void send(upstream, frame).catch(close);
      } catch {
        browser.close(1_008, "workspace terminal frame rejected");
      }
    });
    const connect = async (baseUrl: string, redirects: number): Promise<void> => {
      if (closed) return;
      if (redirects > MAXIMUM_REDIRECTS) throw new Error("too many Tool Broker redirects");
      const target = new URL(baseUrl);
      if (target.protocol === "http:" && !this.#allowInsecureInternalHttp) {
        throw new Error("insecure Tool Broker redirect rejected");
      }
      const connected = new WebSocket(internalWebSocketUrl(target.toString()), {
        headers: { authorization: `Bearer ${this.#terminalToken}` },
        maxPayload: MAX_WORKSPACE_TERMINAL_FRAME_BYTES * 2,
        perMessageDeflate: false,
      });
      upstream = connected;
      await new Promise<void>((resolve, reject) => {
        connected.once("open", resolve);
        connected.once("error", reject);
      });
      await send(connected, descriptor.open);
      let followingRedirect = false;
      connected.on("message", (data: RawData) => {
        void (async () => {
          const frame = parseWorkspaceTerminalServerFrame(JSON.parse(textFrame(data)) as unknown);
          if (frame.type === "workspace_terminal.owner_redirect") {
            const next = await this.#validatedOwnerRedirect(
              descriptor.domainId,
              frame.ownerBaseUrl,
            );
            followingRedirect = true;
            connected.close(1_000, "following owner redirect");
            await connect(next, redirects + 1);
            return;
          }
          if (frame.type === "workspace_terminal.ready") ready = true;
          await send(browser, frame);
          if (
            frame.type === "workspace_terminal.exit" ||
            frame.type === "workspace_terminal.error"
          ) {
            close();
          }
        })().catch(async () => {
          await send(browser, {
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.error",
            code: "workspace_terminal_proxy_failed",
            message: "Workspace terminal proxy failed",
            retryable: true,
          }).catch(() => undefined);
          close();
        });
      });
      connected.once("close", () => {
        if (!closed && !followingRedirect && upstream === connected) close();
      });
      connected.once("error", () => {
        if (!followingRedirect && upstream === connected) close();
      });
    };

    try {
      await connect(descriptor.toolBrokerBaseUrl, 0);
    } catch {
      await send(browser, {
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.error",
        code: "workspace_terminal_proxy_failed",
        message: "Workspace terminal could not reach the Tool Broker",
        retryable: true,
      }).catch(() => undefined);
      close();
    }
  }

  async #descriptor(identity: {
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<TerminalDescriptor> {
    const row = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .innerJoin("sandbox_domains as domain", "domain.id", "workspace.sandbox_domain_id")
      .innerJoin("environment_versions as environment", (join) =>
        join
          .onRef("environment.tenant_id", "=", "workspace.tenant_id")
          .onRef("environment.project_id", "=", "workspace.project_id")
          .on("environment.active", "=", true),
      )
      .leftJoin(
        "workspace_versions as workspace_version",
        "workspace_version.id",
        "workspace.current_workspace_version_id",
      )
      .leftJoin(
        "artifacts as workspace_artifact",
        "workspace_artifact.id",
        "workspace_version.workspace_artifact_id",
      )
      .select([
        "workspace.project_id as projectId",
        "workspace.id as workspaceId",
        "workspace.sandbox_domain_id as domainId",
        "domain.tool_broker_base_url as toolBrokerBaseUrl",
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "workspace_artifact.object_key as workspaceObjectKey",
      ])
      .where("session_row.tenant_id", "=", identity.tenantId)
      .where("session_row.id", "=", identity.sessionId)
      .where("session_row.archived_at", "is", null)
      .where("workspace.deleted_at", "is", null)
      .where("domain.state", "=", "active")
      .where("environment.state", "=", "validated")
      .executeTakeFirstOrThrow();
    const workspace =
      row.workspaceObjectKey === null
        ? createWorkspaceSnapshot([])
        : await this.#checkpointReader.get(row.workspaceObjectKey);
    return {
      domainId: row.domainId,
      toolBrokerBaseUrl: row.toolBrokerBaseUrl,
      open: {
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.open",
        requestId: randomUUID(),
        tenantId: identity.tenantId,
        userId: identity.userId,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        sessionId: identity.sessionId,
        environment: parseEnvironmentRuntimeSnapshot({
          environmentVersionId: row.environmentVersionId,
          versionNumber: row.environmentVersionNumber,
          profileKey: row.environmentProfileKey,
          profileVersion: row.environmentProfileVersion,
          imageRevision: row.environmentImageRevision,
          specSha256: row.environmentSpecSha256,
          recipe: row.environmentRecipe,
          recipeSha256: row.environmentRecipeSha256,
        }),
        workspaceSeed: { kind: "snapshot", snapshot: encodeWorkspaceSnapshotBlob(workspace) },
        rows: 24,
        cols: 100,
      },
    };
  }

  async #validatedOwnerRedirect(domainId: string, ownerBaseUrl: string): Promise<string> {
    const row = await this.#database
      .selectFrom("tool_broker_instances")
      .select("owner_base_url")
      .where("sandbox_domain_id", "=", domainId)
      .where("owner_base_url", "=", new URL(ownerBaseUrl).toString())
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", new Date())
      .executeTakeFirst();
    if (row === undefined) throw new Error("Tool Broker redirect owner was not current");
    return row.owner_base_url;
  }
}
