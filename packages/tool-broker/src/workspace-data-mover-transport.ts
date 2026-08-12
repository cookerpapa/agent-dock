import { createHash, timingSafeEqual } from "node:crypto";
import type { AgentDockMetrics } from "@agent-dock/observability";
import { MAX_WORKSPACE_PATCH_BYTES, type WorkspacePatch } from "@agent-dock/protocol";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import PQueue from "p-queue";
import { fetch } from "undici";
import {
  MAXIMUM_REQUEST_BYTES,
  MAXIMUM_RESPONSE_BYTES,
  TOKEN_PATTERN,
  WORKSPACE_DATA_MOVER_INITIALIZE_BASELINE_PATH,
  WORKSPACE_DATA_MOVER_MATERIALIZE_PATH,
  WORKSPACE_DATA_MOVER_PREPARE_PATH,
  WORKSPACE_DATA_MOVER_SNAPSHOT_PATH,
  WorkspaceDataMoverError,
  digest,
  isRecord,
  validatedGitBaselineCommit,
  validatedSnapshotId,
  type WorkspaceDataMover,
  type WorkspaceDataMoverInitializeBaselineInput,
  type WorkspaceDataMoverMaterializeInput,
  type WorkspaceDataMoverPrepareInput,
  type WorkspaceDataMoverSnapshotInput,
} from "./workspace-data-mover-contract.ts";

export type WorkspaceDataMoverServerOptions = Readonly<{
  host: string;
  port: number;
  serviceToken: string;
  mover: WorkspaceDataMover;
  maximumConcurrentOperations?: number;
  maximumQueuedOperations?: number;
  queueWaitTimeoutMs?: number;
  metrics?: AgentDockMetrics;
}>;

type WorkspaceDataMoverOperation = "prepare" | "initialize_baseline" | "snapshot" | "materialize";

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} was invalid`);
  }
  return value;
}

export class WorkspaceDataMoverServer {
  readonly #server: FastifyInstance;
  readonly #host: string;
  readonly #port: number;
  readonly #tokenDigest: Buffer;
  readonly #mover: WorkspaceDataMover;
  readonly #queue: PQueue;
  readonly #maximumQueuedOperations: number;
  readonly #queueWaitTimeoutMs: number;
  readonly #metrics: AgentDockMetrics | undefined;
  readonly #shutdown = new AbortController();
  #accepting = true;
  #address: string | undefined;

  constructor(options: WorkspaceDataMoverServerOptions) {
    if (!TOKEN_PATTERN.test(options.serviceToken)) {
      throw new TypeError("Workspace Data Mover service token was invalid");
    }
    this.#host = options.host;
    this.#port = options.port;
    this.#tokenDigest = digest(options.serviceToken);
    this.#mover = options.mover;
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
    this.#metrics?.workspaceDataMoverLimit.set(concurrency);
    this.#updateQueueMetrics();
    this.#server = Fastify({
      logger: false,
      bodyLimit: MAXIMUM_REQUEST_BYTES,
      requestTimeout: 11 * 60_000,
    });
    this.#routes();
  }

  async listen(): Promise<string> {
    await this.#mover.checkHealth();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    return this.#address;
  }

  async close(): Promise<void> {
    this.#accepting = false;
    this.#shutdown.abort();
    if (this.#address !== undefined) await this.#server.close();
    await this.#queue.onIdle();
    await this.#mover.close();
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
        await this.#mover.checkHealth();
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
    this.#server.post(WORKSPACE_DATA_MOVER_PREPARE_PATH, async (request, reply) => {
      try {
        return await this.#run("prepare", () =>
          this.#mover.prepare(request.body as WorkspaceDataMoverPrepareInput),
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_DATA_MOVER_INITIALIZE_BASELINE_PATH, async (request, reply) => {
      try {
        return await this.#run("initialize_baseline", () =>
          this.#mover.initializeBaseline(request.body as WorkspaceDataMoverInitializeBaselineInput),
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_DATA_MOVER_SNAPSHOT_PATH, async (request, reply) => {
      try {
        return await this.#run("snapshot", () =>
          this.#mover.snapshot(request.body as WorkspaceDataMoverSnapshotInput),
        );
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
    this.#server.post(WORKSPACE_DATA_MOVER_MATERIALIZE_PATH, async (request, reply) => {
      try {
        const result = await this.#run("materialize", () =>
          this.#mover.materialize(request.body as WorkspaceDataMoverMaterializeInput),
        );
        return reply
          .header("content-type", "application/octet-stream")
          .header("content-length", result.bytes.byteLength)
          .send(Buffer.from(result.bytes));
      } catch (error: unknown) {
        return this.#failure(reply, error);
      }
    });
  }

  async #run<T>(operation: WorkspaceDataMoverOperation, run: () => Promise<T>): Promise<T> {
    if (!this.#accepting) {
      this.#metrics?.workspaceDataMoverRejected.inc({ reason: "shutting_down" });
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_shutting_down",
        "Workspace Data Mover is shutting down",
        true,
      );
    }
    if (
      this.#queue.pending >= this.#queue.concurrency &&
      this.#queue.size >= this.#maximumQueuedOperations
    ) {
      this.#metrics?.workspaceDataMoverRejected.inc({ reason: "queue_full" });
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_overloaded",
        "Workspace Data Mover admission queue is full",
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
        this.#metrics?.workspaceDataMoverQueueWait.observe(
          { operation },
          (performance.now() - queuedAt) / 1_000,
        );
        this.#updateQueueMetrics();
        const startedAt = performance.now();
        try {
          const result = await run();
          this.#metrics?.workspaceDataMoverDuration.observe(
            { operation, outcome: "success" },
            (performance.now() - startedAt) / 1_000,
          );
          return result;
        } catch (error: unknown) {
          this.#metrics?.workspaceDataMoverDuration.observe(
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
        throw new WorkspaceDataMoverError(
          "workspace_data_mover_failed",
          "Workspace Data Mover operation returned no result",
          true,
        );
      }
      return result;
    } catch (error: unknown) {
      if (!started && admission.signal.aborted) {
        const shuttingDown = this.#shutdown.signal.aborted;
        this.#metrics?.workspaceDataMoverQueueWait.observe(
          { operation },
          (performance.now() - queuedAt) / 1_000,
        );
        this.#metrics?.workspaceDataMoverRejected.inc({
          reason: shuttingDown ? "shutting_down" : "queue_timeout",
        });
        throw new WorkspaceDataMoverError(
          shuttingDown
            ? "workspace_data_mover_shutting_down"
            : "workspace_data_mover_queue_timeout",
          shuttingDown
            ? "Workspace Data Mover is shutting down"
            : "Workspace Data Mover admission timed out",
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
    this.#metrics?.workspaceDataMoverActive.set(this.#queue.pending);
    this.#metrics?.workspaceDataMoverWaiting.set(this.#queue.size);
  }

  #failure(reply: FastifyReply, error: unknown): unknown {
    const failure =
      error instanceof WorkspaceDataMoverError
        ? error
        : new WorkspaceDataMoverError(
            "workspace_data_mover_failed",
            "Workspace Data Mover operation failed",
            true,
          );
    return reply.code(failure.retryable ? 503 : 409).send({
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    });
  }
}

export type HttpWorkspaceDataMoverOptions = Readonly<{
  baseUrl: string;
  serviceToken: string;
  requestTimeoutMs?: number;
}>;

export class HttpWorkspaceDataMover implements WorkspaceDataMover {
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #requestTimeoutMs: number;

  constructor(options: HttpWorkspaceDataMoverOptions) {
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
      throw new TypeError("Workspace Data Mover client configuration was invalid");
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
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_unavailable",
        "Workspace Data Mover was unavailable",
        true,
      );
    }
  }

  prepare(input: WorkspaceDataMoverPrepareInput): Promise<{ restored: boolean }> {
    return this.#request(WORKSPACE_DATA_MOVER_PREPARE_PATH, input) as Promise<{
      restored: boolean;
    }>;
  }

  async initializeBaseline(
    input: WorkspaceDataMoverInitializeBaselineInput,
  ): Promise<{ gitBaselineCommit: string }> {
    const response = await this.#request(WORKSPACE_DATA_MOVER_INITIALIZE_BASELINE_PATH, input);
    if (
      !isRecord(response) ||
      Object.keys(response).length !== 1 ||
      typeof response.gitBaselineCommit !== "string"
    ) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return { gitBaselineCommit: validatedGitBaselineCommit(response.gitBaselineCommit) };
  }

  async snapshot(input: WorkspaceDataMoverSnapshotInput): Promise<{
    snapshotId: string;
    gitBaselineCommit: string;
    workspacePatch: WorkspacePatch;
  }> {
    const response = await this.#request(WORKSPACE_DATA_MOVER_SNAPSHOT_PATH, input);
    if (
      !isRecord(response) ||
      Object.keys(response).sort().join("\0") !==
        ["gitBaselineCommit", "snapshotId", "workspacePatch"].sort().join("\0") ||
      typeof response.snapshotId !== "string" ||
      typeof response.gitBaselineCommit !== "string" ||
      !isRecord(response.workspacePatch) ||
      Object.keys(response.workspacePatch).sort().join("\0") !==
        ["format", "patch", "truncated"].sort().join("\0") ||
      response.workspacePatch.format !== "unified_diff" ||
      typeof response.workspacePatch.patch !== "string" ||
      Buffer.byteLength(response.workspacePatch.patch, "utf8") > MAX_WORKSPACE_PATCH_BYTES ||
      typeof response.workspacePatch.truncated !== "boolean"
    ) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return {
      snapshotId: validatedSnapshotId(response.snapshotId),
      gitBaselineCommit: validatedGitBaselineCommit(response.gitBaselineCommit),
      workspacePatch: {
        format: "unified_diff",
        patch: response.workspacePatch.patch,
        truncated: response.workspacePatch.truncated,
      },
    };
  }

  async materialize(
    input: WorkspaceDataMoverMaterializeInput,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const response = await fetch(`${this.#baseUrl}${WORKSPACE_DATA_MOVER_MATERIALIZE_PATH}`, {
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
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_request_failed",
        "Workspace Data Mover request failed",
        response.status >= 500,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > input.maximumBytes)
    ) {
      await response.body?.cancel();
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
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
          throw new WorkspaceDataMoverError(
            "workspace_data_mover_response_invalid",
            "Workspace Data Mover response was invalid",
            false,
          );
        }
        chunks.push(chunk.value);
      }
    }
    const bytes = Buffer.concat(chunks, totalBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== input.expectedSha256) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return { bytes, sha256 };
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
    const text = await response.text();
    if (!response.ok) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_request_failed",
        "Workspace Data Mover request failed",
        response.status >= 500,
      );
    }
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES) {
      throw new WorkspaceDataMoverError(
        "workspace_data_mover_response_invalid",
        "Workspace Data Mover response was invalid",
        false,
      );
    }
    return JSON.parse(text) as unknown;
  }
}
