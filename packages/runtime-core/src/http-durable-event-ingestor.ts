import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
} from "@pi-cloud/protocol";
import type { DurableEventGroupIngestor } from "./durable-event-store.ts";

export const WORKER_EVENT_INGEST_PATH = "/internal/v1/worker-events";

export type HttpDurableEventIngestorOptions = Readonly<{
  baseUrl: string;
  serviceToken: string;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>;

export class HttpDurableEventIngestError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(statusCode: number, safeMessage: string) {
    super(safeMessage);
    this.name = "HttpDurableEventIngestError";
    this.statusCode = statusCode;
    this.retryable = statusCode >= 500;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function endpoint(baseUrl: string, allowInsecureHttp: boolean): URL {
  const parsed = new URL(baseUrl);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("Worker event ingest URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecureHttp) {
    throw new TypeError("Plain HTTP Worker event ingest requires explicit opt-in");
  }
  parsed.pathname = WORKER_EVENT_INGEST_PATH;
  return parsed;
}

function token(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/u.test(value)) {
    throw new TypeError("Worker event ingest service token is invalid");
  }
  return value;
}

export class HttpDurableEventIngestor implements DurableEventGroupIngestor {
  readonly #endpoint: URL;
  readonly #serviceToken: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpDurableEventIngestorOptions) {
    this.#endpoint = endpoint(options.baseUrl, options.allowInsecureHttp ?? false);
    this.#serviceToken = token(options.serviceToken);
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 30_000,
      "requestTimeoutMs",
    );
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    const acknowledgement = (await this.ingestGroup([value]))[0];
    if (acknowledgement === undefined) throw new Error("Worker event acknowledgement is missing");
    return acknowledgement;
  }

  async ingestGroup(values: readonly unknown[]): Promise<readonly EventAckMessage[]> {
    if (values.length < 1 || values.length > 64) {
      throw new TypeError("Worker event ingest group is invalid");
    }
    const publications = values.map((value) => {
      const message = parseSupervisorToControlMessage(value);
      if (message.type !== "event.publish" && message.type !== "event.publish_batch") {
        throw new TypeError("Worker event ingest accepts only event publications");
      }
      return message;
    });
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schemaVersion: 1, publications }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      const candidate =
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error?: unknown }).error
          : undefined;
      const message =
        typeof candidate === "object" &&
        candidate !== null &&
        "message" in candidate &&
        typeof (candidate as { message?: unknown }).message === "string"
          ? (candidate as { message: string }).message
          : "Worker event ingest gateway rejected the publication";
      throw new HttpDurableEventIngestError(response.status, message);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("acknowledgements" in body) ||
      !Array.isArray((body as { acknowledgements?: unknown }).acknowledgements)
    ) {
      throw new Error("Worker event ingest gateway returned an invalid response");
    }
    const acknowledgements = (body as { acknowledgements: unknown[] }).acknowledgements.map(
      (value) => {
        const message = parseControlToSupervisorMessage(value);
        if (message.type !== "event.ack") {
          throw new Error("Worker event ingest gateway returned a non-event acknowledgement");
        }
        return message;
      },
    );
    if (acknowledgements.length !== publications.length) {
      throw new Error("Worker event ingest gateway returned an incomplete acknowledgement group");
    }
    return acknowledgements;
  }
}
