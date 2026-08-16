import { createHash, timingSafeEqual } from "node:crypto";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { MAX_WORKSPACE_PATCH_BYTES, type WorkspacePatch } from "@pi-cloud/protocol";
import {
  validateWorkspaceFileList,
  type WorkspaceSnapshotFileMetadata,
} from "@pi-cloud/workspace-runtime";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import PQueue from "p-queue";
import { fetch } from "undici";
import {
  MAXIMUM_REQUEST_BYTES,
  MAXIMUM_RESPONSE_BYTES,
  TOKEN_PATTERN,
  WORKSPACE_VOLUME_GATEWAY_INITIALIZE_BASELINE_PATH,
  WORKSPACE_VOLUME_GATEWAY_MATERIALIZE_PATH,
  WORKSPACE_VOLUME_GATEWAY_DELETE_PATH,
  WORKSPACE_VOLUME_GATEWAY_PREPARE_PATH,
  WORKSPACE_VOLUME_GATEWAY_SNAPSHOT_PATH,
  WorkspaceVolumeGatewayError,
  digest,
  isRecord,
  validatedGitBaselineCommit,
  type WorkspaceVolumeGateway,
  type WorkspaceVolumeGatewayInitializeBaselineInput,
  type WorkspaceVolumeGatewayMaterializeInput,
  type WorkspaceVolumeGatewayDeleteInput,
  type WorkspaceVolumeGatewayPrepareInput,
  type WorkspaceVolumeGatewaySnapshotInput,
} from "./workspace-volume-gateway-contract.ts";

export type WorkspaceVolumeGatewayServerOptions = Readonly<{
  host: string;
  port: number;
  serviceToken: string;
  gateway: WorkspaceVolumeGateway;
  maximumConcurrentOperations?: number;
  maximumQueuedOperations?: number;
  queueWaitTimeoutMs?: number;
  metrics?: PiCloudMetrics;
}>;

type WorkspaceVolumeGatewayOperation =
  "prepare" | "initialize_baseline" | "snapshot" | "materialize" | "delete";

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} was invalid`);
  }
  return value;
}

export class WorkspaceVolumeGatewayServer {
  readonly #server: FastifyInstance;
  readonly #host: string;
  readonly #port: number;
  readonly #tokenDigest: Buffer;
  readonly #gateway: WorkspaceVolumeGateway;
  readonly #queue: PQueue;
  readonly #maximumQueuedOperations: number;
  readonly #queueWaitTimeoutMs: number;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #shutdown = new AbortController();
  #accepting = true;
  #address: string | undefined;

  constructor(options: WorkspaceVolumeGatewayServerOptions) {
    if (!TOKEN_PATTERN.test(options.serviceToken)) {
      throw new TypeError("Workspace Volume Gateway service token was invalid");
    }
    this.#host = options.host;
    this.#port = options.port;
    this.#tokenDigest = digest(options.serviceToken);
    this.#gateway = options.gateway;
    const concurrency = boundedInteger(
      options.maximumConcurrentOperations ?? 2,
      "maximumConcurrentOperations",
      1,
      64,
    );
    this.#maximumQueuedOperations = boundedInteger(
      options.maximumQueuedOperations ?? 32,
      "maximumQueuedOperations",
      0,
      4_096,
    );
    this.#queueWaitTimeoutMs = boundedInteger(
      options.queueWaitTimeoutMs ?? 30_000,
      "queueWaitTimeoutMs",
      1,
      600_000,
    );
    this.#metrics = options.metrics;
    this.#queue = new PQueue({ concurrency });
    this.#metrics?.workspaceVolumeGatewayLimit.set(concurrency);
    this.#updateQueueMetrics();
    this.#server = Fastify({
      logger: false,
      bodyLimit: MAXIMUM_REQUEST_BYTES,
      requestTimeout: 11 * 60_000,
    });
    this.#routes();
  }

  async listen(): Promise<string> {
    await this.#gateway.checkHealth();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    return this.#address;
  }

  async close(): Promise<void> {
    this.#accepting = false;
    this.#shutdown.abort();
    if (this.#address !== undefined) await this.#server.close();
    await this.#queue.onIdle();
    await this.#gateway.close();
    this.#address = undefined;
  }

  #authorized(value: string | undefined): boolean {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value ?? "");
    const token = match?.[1];
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return match !== null && timingSafeEqual(candidate, this.#tokenDigest);
  }

  #routes(): void {
    this.#server.get("/health/live", async () => ({ status: "ok" }));
    this.#server.get("/health/ready", async (_request, reply) => {
      try {
        await this.#gateway.checkHealth();
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "not_ready" });
      }
    });
    this.#server.addHook("preHandler", async (request, reply) => {
      if (request.url.startsWith("/health/")) return;
      if (!this.#authorized(request.headers.authorization)) {
        return reply.code(401).send({ error: { code: "unauthorized", retryable: false } });
      }
    });
    this.#server.post(WORKSPACE_VOLUME_GATEWAY_PREPARE_PATH, async (request, reply) => {
      try {
        return await this.#run("prepare", () =>
          this.#gateway.prepare(request.body as WorkspaceVolumeGatewayPrepareInput),
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_VOLUME_GATEWAY_INITIALIZE_BASELINE_PATH, async (request, reply) => {
      try {
        return await this.#run("initialize_baseline", () =>
          this.#gateway.initializeBaseline(
            request.body as WorkspaceVolumeGatewayInitializeBaselineInput,
          ),
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_VOLUME_GATEWAY_SNAPSHOT_PATH, async (request, reply) => {
      try {
        return await this.#run("snapshot", () =>
          this.#gateway.snapshot(request.body as WorkspaceVolumeGatewaySnapshotInput),
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_VOLUME_GATEWAY_MATERIALIZE_PATH, async (request, reply) => {
      try {
        const result = await this.#run("materialize", () =>
          this.#gateway.materialize(request.body as WorkspaceVolumeGatewayMaterializeInput),
        );
        return reply
          .header("content-type", "application/octet-stream")
          .header("content-length", result.bytes.byteLength)
          .send(Buffer.from(result.bytes));
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_VOLUME_GATEWAY_DELETE_PATH, async (request, reply) => {
      try {
        return await this.#run("delete", () =>
          this.#gateway.delete(request.body as WorkspaceVolumeGatewayDeleteInput),
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
  }

  async #run<T>(operation: WorkspaceVolumeGatewayOperation, run: () => Promise<T>): Promise<T> {
    if (!this.#accepting) {
      this.#metrics?.workspaceVolumeGatewayRejected.inc({ reason: "shutting_down" });
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_shutting_down",
        "Workspace Volume Gateway is shutting down",
        true,
      );
    }
    if (
      this.#queue.pending >= this.#queue.concurrency &&
      this.#queue.size >= this.#maximumQueuedOperations
    ) {
      this.#metrics?.workspaceVolumeGatewayRejected.inc({ reason: "queue_full" });
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_overloaded",
        "Workspace Volume Gateway admission queue is full",
        true,
      );
    }

    const queuedAt = performance.now();
    const admission = new AbortController();
    let started = false;
    const abortForShutdown = (): void => admission.abort();
    this.#shutdown.signal.addEventListener("abort", abortForShutdown, { once: true });
    const timeout = setTimeout(() => admission.abort(), this.#queueWaitTimeoutMs);
    timeout.unref();

    const task = this.#queue.add(
      async () => {
        started = true;
        clearTimeout(timeout);
        this.#shutdown.signal.removeEventListener("abort", abortForShutdown);
        this.#metrics?.workspaceVolumeGatewayQueueWait.observe(
          { operation },
          (performance.now() - queuedAt) / 1_000,
        );
        this.#updateQueueMetrics();
        const startedAt = performance.now();
        try {
          const result = await run();
          this.#metrics?.workspaceVolumeGatewayDuration.observe(
            { operation, outcome: "success" },
            (performance.now() - startedAt) / 1_000,
          );
          return result;
        } catch (error: unknown) {
          this.#metrics?.workspaceVolumeGatewayDuration.observe(
            { operation, outcome: "failure" },
            (performance.now() - startedAt) / 1_000,
          );
          throw error;
        } finally {
          queueMicrotask(() => this.#updateQueueMetrics());
        }
      },
      { signal: admission.signal },
    );
    this.#updateQueueMetrics();

    try {
      const result = await task;
      if (result === undefined) {
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_gateway_failed",
          "Workspace Volume Gateway operation returned no result",
          true,
        );
      }
      return result;
    } catch (error: unknown) {
      if (!started && admission.signal.aborted) {
        const shuttingDown = this.#shutdown.signal.aborted;
        this.#metrics?.workspaceVolumeGatewayQueueWait.observe(
          { operation },
          (performance.now() - queuedAt) / 1_000,
        );
        this.#metrics?.workspaceVolumeGatewayRejected.inc({
          reason: shuttingDown ? "shutting_down" : "queue_timeout",
        });
        throw new WorkspaceVolumeGatewayError(
          shuttingDown
            ? "workspace_volume_gateway_shutting_down"
            : "workspace_volume_gateway_queue_timeout",
          shuttingDown
            ? "Workspace Volume Gateway is shutting down"
            : "Workspace Volume Gateway admission timed out",
          true,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.#shutdown.signal.removeEventListener("abort", abortForShutdown);
      this.#updateQueueMetrics();
    }
  }

  #updateQueueMetrics(): void {
    this.#metrics?.workspaceVolumeGatewayActive.set(this.#queue.pending);
    this.#metrics?.workspaceVolumeGatewayWaiting.set(this.#queue.size);
  }

  #failure(reply: FastifyReply, error: unknown): unknown {
    const failure =
      error instanceof WorkspaceVolumeGatewayError
        ? error
        : new WorkspaceVolumeGatewayError(
            "workspace_volume_gateway_failed",
            "Workspace Volume Gateway operation failed",
            true,
          );
    return reply.code(failure.retryable ? 503 : 409).send({
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    });
  }
}

export type HttpWorkspaceVolumeGatewayOptions = Readonly<{
  baseUrl: string;
  serviceToken: string;
  requestTimeoutMs?: number;
}>;

export class HttpWorkspaceVolumeGateway implements WorkspaceVolumeGateway {
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #requestTimeoutMs: number;

  constructor(options: HttpWorkspaceVolumeGatewayOptions) {
    const url = new URL(options.baseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== "" ||
      !TOKEN_PATTERN.test(options.serviceToken)
    ) {
      throw new TypeError("Workspace Volume Gateway client configuration was invalid");
    }
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#serviceToken = options.serviceToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 11 * 60_000;
  }

  async checkHealth(): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/health/ready`, {
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_unavailable",
        "Workspace Volume Gateway was unavailable",
        true,
      );
    }
  }

  prepare(input: WorkspaceVolumeGatewayPrepareInput): Promise<{ attached: boolean }> {
    return this.#request(WORKSPACE_VOLUME_GATEWAY_PREPARE_PATH, input) as Promise<{
      attached: boolean;
    }>;
  }

  async initializeBaseline(
    input: WorkspaceVolumeGatewayInitializeBaselineInput,
  ): Promise<{ gitBaselineCommit: string }> {
    const response = await this.#request(WORKSPACE_VOLUME_GATEWAY_INITIALIZE_BASELINE_PATH, input);
    if (
      !isRecord(response) ||
      Object.keys(response).length !== 1 ||
      typeof response.gitBaselineCommit !== "string"
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_response_invalid",
        "Workspace Volume Gateway response was invalid",
        false,
      );
    }
    return { gitBaselineCommit: validatedGitBaselineCommit(response.gitBaselineCommit) };
  }

  async snapshot(input: WorkspaceVolumeGatewaySnapshotInput): Promise<{
    volumeRevision: string;
    gitBaselineCommit: string;
    workspacePatch: WorkspacePatch;
    files: readonly WorkspaceSnapshotFileMetadata[];
  }> {
    const response = await this.#request(WORKSPACE_VOLUME_GATEWAY_SNAPSHOT_PATH, input);
    if (
      !isRecord(response) ||
      Object.keys(response).sort().join("\0") !==
        ["files", "gitBaselineCommit", "volumeRevision", "workspacePatch"].sort().join("\0") ||
      typeof response.volumeRevision !== "string" ||
      !/^[0-9a-f]{64}$/.test(response.volumeRevision) ||
      typeof response.gitBaselineCommit !== "string" ||
      !isRecord(response.workspacePatch) ||
      Object.keys(response.workspacePatch).sort().join("\0") !==
        ["format", "patch", "truncated"].sort().join("\0") ||
      response.workspacePatch.format !== "unified_diff" ||
      typeof response.workspacePatch.patch !== "string" ||
      Buffer.byteLength(response.workspacePatch.patch, "utf8") > MAX_WORKSPACE_PATCH_BYTES ||
      typeof response.workspacePatch.truncated !== "boolean"
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_response_invalid",
        "Workspace Volume Gateway response was invalid",
        false,
      );
    }
    return {
      volumeRevision: response.volumeRevision,
      gitBaselineCommit: validatedGitBaselineCommit(response.gitBaselineCommit),
      files: validateWorkspaceFileList(response.files),
      workspacePatch: {
        format: "unified_diff",
        patch: response.workspacePatch.patch,
        truncated: response.workspacePatch.truncated,
      },
    };
  }

  async materialize(
    input: WorkspaceVolumeGatewayMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const response = await fetch(`${this.#baseUrl}${WORKSPACE_VOLUME_GATEWAY_MATERIALIZE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_request_failed",
        "Workspace Volume Gateway request failed",
        response.status >= 500,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > input.maximumBytes)
    ) {
      await response.body?.cancel();
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_response_invalid",
        "Workspace Volume Gateway response was invalid",
        false,
      );
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (reader !== undefined) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > input.maximumBytes) {
          await reader.cancel();
          throw new WorkspaceVolumeGatewayError(
            "workspace_volume_gateway_response_invalid",
            "Workspace Volume Gateway response was invalid",
            false,
          );
        }
        chunks.push(chunk.value);
      }
    }
    const bytes = Buffer.concat(chunks, totalBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== input.expectedSha256) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_response_invalid",
        "Workspace Volume Gateway response was invalid",
        false,
      );
    }
    return { bytes, sha256 };
  }

  async delete(input: WorkspaceVolumeGatewayDeleteInput): Promise<{ deleted: boolean }> {
    const response = await this.#request(WORKSPACE_VOLUME_GATEWAY_DELETE_PATH, input);
    if (
      !isRecord(response) ||
      Object.keys(response).length !== 1 ||
      typeof response.deleted !== "boolean"
    ) {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_response_invalid",
        "Workspace Volume Gateway response was invalid",
        false,
      );
    }
    return { deleted: response.deleted };
  }

  async close(): Promise<void> {}

  async #request(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_request_failed",
        "Workspace Volume Gateway request failed",
        response.status >= 500,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > MAXIMUM_RESPONSE_BYTES)
    ) {
      await response.body?.cancel();
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_response_invalid",
        "Workspace Volume Gateway response was invalid",
        false,
      );
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (reader !== undefined) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
          await reader.cancel();
          throw new WorkspaceVolumeGatewayError(
            "workspace_volume_gateway_response_invalid",
            "Workspace Volume Gateway response was invalid",
            false,
          );
        }
        chunks.push(chunk.value);
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
    } catch {
      throw new WorkspaceVolumeGatewayError(
        "workspace_volume_gateway_response_invalid",
        "Workspace Volume Gateway response was invalid",
        false,
      );
    }
  }
}
