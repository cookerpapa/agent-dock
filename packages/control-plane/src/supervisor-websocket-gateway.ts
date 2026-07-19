import fastifyWebsocket from "@fastify/websocket";
import { parseSupervisorToControlMessage } from "@agent-dock/protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import type { TLSSocket } from "node:tls";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  SupervisorCommandTransportError,
  type SupervisorCommandConnection,
  type SupervisorCommandRouter,
} from "./supervisor-command-router.ts";
import {
  SupervisorConnectionManagerError,
  type SupervisorBootIdentity,
  type SupervisorTransportAuthority,
} from "./supervisor-connection-manager.ts";
import type { SupervisorConnectionManager } from "./supervisor-connection-manager.ts";
import type { SessionLeaseCoordinator } from "./session-lease-coordinator.ts";
import { RemoteSupervisorExecutionBackend } from "./remote-supervisor-execution-backend.ts";

export const SUPERVISOR_WEBSOCKET_PATH = "/internal/v1/supervisor";
export const SUPERVISOR_SOCKET_CLOSE = {
  SUPERSEDED: 4_001,
  OVERLOADED: 4_002,
} as const;

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_FRAMES = 8;
const DEFAULT_MAX_BUFFERED_SEND_BYTES = 1024 * 1024;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;

export type SupervisorUpgradeRequest = {
  authorization: string | undefined;
  remoteAddress: string | undefined;
  tlsAuthorized: boolean;
  peerCertificateFingerprint256: string | undefined;
};

export interface SupervisorUpgradeAuthorizer {
  authorize(request: SupervisorUpgradeRequest): Promise<SupervisorBootIdentity>;
}

export type SupervisorWebSocketGatewayOptions = {
  manager: SupervisorConnectionManager;
  authorizer: SupervisorUpgradeAuthorizer;
  path?: string;
  idGenerator?: () => string;
  maxPayloadBytes?: number;
  maxPendingFrames?: number;
  maxBufferedSendBytes?: number;
  registrationTimeoutMs?: number;
  commandRouter?: SupervisorCommandRouter;
};

export class SupervisorUpgradeAuthorizationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorUpgradeAuthorizationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type HashedBearerSupervisorAuthorizerOptions = {
  token: string;
  identity: SupervisorBootIdentity;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function validPath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new TypeError("supervisor WebSocket path must be an absolute path without query or hash");
  }
  return value;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || authorization.length > 4_103) return undefined;
  const matched = /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(authorization);
  return matched?.[1];
}

function textFrame(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function upgradeRequest(request: FastifyRequest): SupervisorUpgradeRequest {
  const authorization = request.headers.authorization;
  const rawSocket = request.raw.socket;
  const tlsSocket = rawSocket as Partial<TLSSocket>;
  let peerCertificateFingerprint256: string | undefined;
  if (typeof tlsSocket.getPeerCertificate === "function") {
    const certificate = tlsSocket.getPeerCertificate();
    peerCertificateFingerprint256 = certificate.fingerprint256 || undefined;
  }
  return {
    authorization: typeof authorization === "string" ? authorization : undefined,
    remoteAddress: rawSocket.remoteAddress,
    tlsAuthorized: tlsSocket.authorized === true,
    peerCertificateFingerprint256,
  };
}

/**
 * Single-identity development/test authorizer. It drops the plaintext token
 * after construction and never exposes it through an error or return value.
 */
export class HashedBearerSupervisorAuthorizer implements SupervisorUpgradeAuthorizer {
  readonly #digest: Buffer;
  readonly #identity: SupervisorBootIdentity;

  constructor(options: HashedBearerSupervisorAuthorizerOptions) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.token)) {
      throw new TypeError("supervisor bearer token must contain 32-4096 bounded ASCII bytes");
    }
    this.#digest = tokenDigest(options.token);
    this.#identity = {
      supervisorId: nonEmpty(options.identity.supervisorId, "identity.supervisorId"),
      bootId: requireUuid(options.identity.bootId, "identity.bootId"),
      sandboxId: requireUuid(options.identity.sandboxId, "identity.sandboxId"),
    };
  }

  async authorize(request: SupervisorUpgradeRequest): Promise<SupervisorBootIdentity> {
    const token = bearerToken(request.authorization);
    const candidate = token === undefined ? Buffer.alloc(this.#digest.length) : tokenDigest(token);
    if (!timingSafeEqual(this.#digest, candidate) || token === undefined) {
      throw new SupervisorUpgradeAuthorizationError(
        "invalid_supervisor_credential",
        "Supervisor upgrade is not authorized",
        false,
      );
    }
    return { ...this.#identity };
  }
}

type SocketContext = {
  socket: WebSocket;
  authority: SupervisorTransportAuthority;
  registeredConnectionId: string | undefined;
  pendingFrames: number;
  closed: boolean;
  processing: Promise<void>;
  registrationTimer: NodeJS.Timeout | undefined;
  commandConnection: SupervisorCommandConnection | undefined;
};

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.OPEN) {
    socket.close(code, reason);
  } else if (socket.readyState !== socket.CLOSED) {
    socket.terminate();
  }
}

export class SupervisorWebSocketGateway {
  readonly #manager: SupervisorConnectionManager;
  readonly #authorizer: SupervisorUpgradeAuthorizer;
  readonly #path: string;
  readonly #idGenerator: () => string;
  readonly #maxPayloadBytes: number;
  readonly #maxPendingFrames: number;
  readonly #maxBufferedSendBytes: number;
  readonly #registrationTimeoutMs: number;
  readonly #commandRouter: SupervisorCommandRouter | undefined;
  readonly #authorizedRequests = new WeakMap<FastifyRequest, SupervisorBootIdentity>();
  readonly #activeBySandbox = new Map<string, SocketContext>();
  #installed = false;

  constructor(options: SupervisorWebSocketGatewayOptions) {
    this.#manager = options.manager;
    this.#authorizer = options.authorizer;
    this.#path = validPath(options.path ?? SUPERVISOR_WEBSOCKET_PATH);
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#maxPayloadBytes = positiveInteger(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
    );
    this.#maxPendingFrames = positiveInteger(
      options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES,
      "maxPendingFrames",
    );
    this.#maxBufferedSendBytes = positiveInteger(
      options.maxBufferedSendBytes ?? DEFAULT_MAX_BUFFERED_SEND_BYTES,
      "maxBufferedSendBytes",
    );
    this.#registrationTimeoutMs = positiveInteger(
      options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS,
      "registrationTimeoutMs",
    );
    this.#commandRouter = options.commandRouter;
  }

  get activeConnectionCount(): number {
    return this.#activeBySandbox.size;
  }

  async currentLeaseCoordinator(sandboxId: string): Promise<SessionLeaseCoordinator> {
    const context = this.#activeBySandbox.get(sandboxId);
    if (context === undefined || context.closed || context.registeredConnectionId === undefined) {
      throw new SupervisorConnectionManagerError(
        "supervisor_connection_unavailable",
        "Supervisor connection is unavailable",
        true,
      );
    }
    return this.#manager.leaseCoordinator(context.registeredConnectionId, context.authority);
  }

  createRemoteExecutionBackend(sandboxId: string): RemoteSupervisorExecutionBackend {
    if (this.#commandRouter === undefined) {
      throw new SupervisorConnectionManagerError(
        "supervisor_command_router_unavailable",
        "Supervisor command router is unavailable",
        false,
      );
    }
    return new RemoteSupervisorExecutionBackend({
      sandboxId,
      transport: this.#commandRouter,
      leaseCoordinatorProvider: () => this.currentLeaseCoordinator(sandboxId),
    });
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("supervisor WebSocket gateway is already installed");
    this.#installed = true;
    fastify.register(fastifyWebsocket, {
      options: {
        maxPayload: this.#maxPayloadBytes,
        perMessageDeflate: false,
      },
      errorHandler: (_error, socket) => {
        closeSocket(socket, 1_011, "websocket handler failed");
      },
    });
    fastify.register(async (scope) => {
      scope.addHook("preValidation", async (request, reply) => {
        try {
          const identity = await this.#authorizer.authorize(upgradeRequest(request));
          this.#authorizedRequests.set(request, {
            supervisorId: nonEmpty(identity.supervisorId, "authorized supervisorId"),
            bootId: requireUuid(identity.bootId, "authorized bootId"),
            sandboxId: requireUuid(identity.sandboxId, "authorized sandboxId"),
          });
        } catch (error: unknown) {
          const retryable =
            error instanceof SupervisorUpgradeAuthorizationError ? error.retryable : true;
          await reply.code(retryable ? 503 : 401).send();
        }
      });
      scope.get(this.#path, { websocket: true }, (socket, request) => {
        const identity = this.#authorizedRequests.get(request);
        this.#authorizedRequests.delete(request);
        if (identity === undefined) {
          closeSocket(socket, 1_008, "upgrade authority missing");
          return;
        }
        this.#acceptSocket(socket, identity);
      });
    });
  }

  #acceptSocket(socket: WebSocket, identity: SupervisorBootIdentity): void {
    const context: SocketContext = {
      socket,
      authority: {
        ...identity,
        transportId: requireUuid(this.#idGenerator(), "generated transportId"),
      },
      registeredConnectionId: undefined,
      pendingFrames: 0,
      closed: false,
      processing: Promise.resolve(),
      registrationTimer: undefined,
      commandConnection: undefined,
    };
    context.registrationTimer = setTimeout(() => {
      this.#close(context, 1_008, "registration timeout");
    }, this.#registrationTimeoutMs);
    context.registrationTimer.unref();

    socket.on("message", (data, isBinary) => {
      if (context.closed) return;
      context.pendingFrames += 1;
      if (context.pendingFrames > this.#maxPendingFrames) {
        context.pendingFrames -= 1;
        this.#close(context, SUPERVISOR_SOCKET_CLOSE.OVERLOADED, "frame queue overloaded");
        return;
      }
      context.processing = context.processing
        .then(async () => {
          if (!context.closed) await this.#processFrame(context, data, isBinary);
        })
        .catch((error: unknown) => {
          this.#handleFrameError(context, error);
        })
        .finally(() => {
          context.pendingFrames -= 1;
        });
    });
    socket.once("close", () => {
      this.#cleanup(context);
    });
    socket.once("error", () => {
      this.#close(context, 1_011, "websocket transport failed");
    });
  }

  async #processFrame(context: SocketContext, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.#close(context, 1_003, "binary frames unsupported");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(textFrame(data));
    } catch {
      this.#close(context, 1_002, "invalid json frame");
      return;
    }
    let message;
    try {
      message = parseSupervisorToControlMessage(value);
    } catch {
      this.#close(context, 1_002, "invalid protocol frame");
      return;
    }

    if (message.type === "supervisor.register") {
      const acknowledgement = await this.#manager.register(message, context.authority);
      if (
        context.registeredConnectionId !== undefined &&
        context.registeredConnectionId !== acknowledgement.payload.connectionId
      ) {
        this.#close(context, 1_008, "registration generation changed");
        return;
      }
      context.registeredConnectionId = acknowledgement.payload.connectionId;
      if (context.registrationTimer !== undefined) {
        clearTimeout(context.registrationTimer);
        context.registrationTimer = undefined;
      }
      const previous = this.#activeBySandbox.get(context.authority.sandboxId);
      this.#activeBySandbox.set(context.authority.sandboxId, context);
      if (previous !== undefined && previous !== context) {
        this.#close(previous, SUPERVISOR_SOCKET_CLOSE.SUPERSEDED, "connection superseded");
      }
      if (this.#commandRouter !== undefined && context.commandConnection === undefined) {
        const connection: SupervisorCommandConnection = {
          supervisorId: context.authority.supervisorId,
          bootId: context.authority.bootId,
          sandboxId: context.authority.sandboxId,
          connectionId: acknowledgement.payload.connectionId,
          capabilities: [...message.payload.capabilities],
          send: (outbound) => this.#send(context, outbound),
          assertEventAuthority: (event) =>
            this.#manager.assertEventAuthority(
              acknowledgement.payload.connectionId,
              context.authority,
              event,
            ),
        };
        context.commandConnection = connection;
        this.#commandRouter.attach(connection);
      }
      await this.#send(context, acknowledgement);
      return;
    }

    if (context.registeredConnectionId === undefined) {
      this.#close(context, 1_008, "registration required");
      return;
    }
    if (message.type === "supervisor.heartbeat") {
      if (message.payload.connectionId !== context.registeredConnectionId) {
        this.#close(context, 1_008, "stale connection");
        return;
      }
      const acknowledgement = await this.#manager.heartbeat(message, context.authority);
      await this.#send(context, acknowledgement);
      return;
    }
    if (this.#commandRouter !== undefined && context.commandConnection !== undefined) {
      await this.#manager.assertCurrentConnection(
        context.registeredConnectionId,
        context.authority,
      );
      if (await this.#commandRouter.receive(context.commandConnection, message)) return;
    }
    this.#close(context, 1_003, "message type unsupported");
  }

  async #send(context: SocketContext, value: unknown): Promise<void> {
    if (context.closed || context.socket.readyState !== context.socket.OPEN) {
      throw new SupervisorConnectionManagerError(
        "supervisor_transport_closed",
        "Supervisor transport closed before response",
        true,
      );
    }
    const payload = JSON.stringify(value);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (
      payloadBytes > this.#maxBufferedSendBytes ||
      context.socket.bufferedAmount + payloadBytes > this.#maxBufferedSendBytes
    ) {
      this.#close(context, SUPERVISOR_SOCKET_CLOSE.OVERLOADED, "send buffer overloaded");
      return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      context.socket.send(payload, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }

  #handleFrameError(context: SocketContext, error: unknown): void {
    if (context.closed) return;
    if (error instanceof SupervisorConnectionManagerError) {
      this.#close(
        context,
        error.retryable ? 1_011 : 1_008,
        error.retryable ? "supervisor service unavailable" : "supervisor message rejected",
      );
      return;
    }
    if (error instanceof SupervisorCommandTransportError) {
      this.#close(
        context,
        error.retryable ? 1_011 : 1_008,
        error.retryable ? "supervisor command service unavailable" : "supervisor command rejected",
      );
      return;
    }
    this.#close(context, 1_011, "supervisor message failed");
  }

  #close(context: SocketContext, code: number, reason: string): void {
    if (context.closed) return;
    context.closed = true;
    this.#cleanup(context);
    closeSocket(context.socket, code, reason);
  }

  #cleanup(context: SocketContext): void {
    if (context.registrationTimer !== undefined) {
      clearTimeout(context.registrationTimer);
      context.registrationTimer = undefined;
    }
    if (this.#activeBySandbox.get(context.authority.sandboxId) === context) {
      this.#activeBySandbox.delete(context.authority.sandboxId);
    }
    if (context.commandConnection !== undefined) {
      this.#commandRouter?.detach(context.commandConnection);
      context.commandConnection = undefined;
    }
  }
}
