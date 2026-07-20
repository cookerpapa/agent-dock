import { parseAgentDockEvent, type AgentDockEvent } from "@agent-dock/protocol";

const MAX_PENDING_FRAME_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 5_000;

export type SessionStreamPhase = "connecting" | "live" | "reconnecting" | "failed";

export type SessionStreamStatus = {
  phase: SessionStreamPhase;
  attempt: number;
  lastSequence: number;
  retryInMs?: number;
  message?: string;
};

export type SseFrame = {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
};

export class SessionStreamError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SessionStreamError";
    this.retryable = retryable;
  }
}

export class SseFrameParser {
  #buffer = "";
  #firstPush = true;

  push(value: string): readonly SseFrame[] {
    let chunk = value;
    if (this.#firstPush) {
      this.#firstPush = false;
      if (chunk.startsWith("\uFEFF")) chunk = chunk.slice(1);
    }
    this.#buffer += chunk;
    if (new TextEncoder().encode(this.#buffer).byteLength > MAX_PENDING_FRAME_BYTES) {
      throw new SessionStreamError("SSE frame exceeded the browser buffer limit", false);
    }

    const frames: SseFrame[] = [];
    let boundary = /\r?\n\r?\n/.exec(this.#buffer);
    while (boundary !== null) {
      const raw = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary[0].length);
      const frame = parseFrame(raw);
      if (frame !== undefined) frames.push(frame);
      boundary = /\r?\n\r?\n/.exec(this.#buffer);
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    if (field === "event") event = value;
    if (field === "id" && !value.includes("\0")) id = value;
    if (field === "retry" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) retry = parsed;
    }
  }
  if (data.length === 0) return undefined;
  return {
    data: data.join("\n"),
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    ...(retry === undefined ? {} : { retry }),
  };
}

type FetchImplementation = typeof fetch;

export type StreamSessionEventsOptions = {
  sessionId: string;
  afterSequence: number;
  signal: AbortSignal;
  onEvent(event: AgentDockEvent): void;
  onStatus(status: SessionStreamStatus): void;
  fetchImplementation?: FetchImplementation;
  retryDelayMs?: number;
  authorizationToken?: string;
};

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function retryDelay(baseDelay: number, attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, baseDelay * 2 ** Math.min(attempt - 1, 4));
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
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

async function consumeResponse(
  response: Response,
  sessionId: string,
  initialSequence: number,
  signal: AbortSignal,
  onEvent: (event: AgentDockEvent) => void,
): Promise<{ lastSequence: number; retryMs?: number }> {
  if (response.body === null) {
    throw new SessionStreamError("SSE response did not include a body", true);
  }
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let lastSequence = initialSequence;
  let serverRetryMs: number | undefined;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        if (frame.retry !== undefined) serverRetryMs = frame.retry;
        let value: unknown;
        try {
          value = JSON.parse(frame.data) as unknown;
        } catch {
          throw new SessionStreamError("SSE event contained malformed JSON", false);
        }
        let event: AgentDockEvent;
        try {
          event = parseAgentDockEvent(value);
        } catch {
          throw new SessionStreamError("SSE event violated the AgentDock contract", false);
        }
        if (event.sessionId !== sessionId) {
          throw new SessionStreamError("SSE event belongs to a different session", false);
        }
        if (frame.id === undefined || !/^[1-9]\d*$/.test(frame.id)) {
          throw new SessionStreamError("SSE event has an invalid sequence ID", false);
        }
        if (Number(frame.id) !== event.seq || frame.event !== event.type) {
          throw new SessionStreamError("SSE frame identity does not match its event", false);
        }
        if (event.seq <= lastSequence) continue;
        if (event.seq !== lastSequence + 1) {
          throw new SessionStreamError("SSE event sequence contains a gap", true);
        }
        onEvent(event);
        lastSequence = event.seq;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    lastSequence,
    ...(serverRetryMs === undefined ? {} : { retryMs: serverRetryMs }),
  };
}

export async function streamSessionEvents(options: StreamSessionEventsOptions): Promise<number> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const baseRetryDelay = nonNegativeInteger(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
  );
  let lastSequence = nonNegativeInteger(options.afterSequence, "afterSequence");
  let attempt = 0;
  let serverRetryMs: number | undefined;

  while (!options.signal.aborted) {
    options.onStatus({
      phase: attempt === 0 ? "connecting" : "reconnecting",
      attempt,
      lastSequence,
    });
    try {
      const response = await fetchImplementation(
        `/v1/sessions/${encodeURIComponent(options.sessionId)}/events`,
        {
          method: "GET",
          credentials: "same-origin",
          headers: {
            accept: "text/event-stream",
            "last-event-id": String(lastSequence),
            ...(options.authorizationToken === undefined
              ? {}
              : { authorization: `Bearer ${options.authorizationToken}` }),
          },
          cache: "no-store",
          signal: options.signal,
        },
      );
      if (!response.ok) {
        const retryable =
          response.status >= 500 || response.status === 408 || response.status === 429;
        throw new SessionStreamError(
          `Event stream rejected with HTTP ${String(response.status)}`,
          retryable,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("text/event-stream")) {
        throw new SessionStreamError("Event stream returned an unexpected content type", false);
      }
      options.onStatus({ phase: "live", attempt, lastSequence });
      const consumed = await consumeResponse(
        response,
        options.sessionId,
        lastSequence,
        options.signal,
        options.onEvent,
      );
      lastSequence = consumed.lastSequence;
      serverRetryMs = consumed.retryMs ?? serverRetryMs;
      if (options.signal.aborted) return lastSequence;
      throw new SessionStreamError("Event stream closed; replaying from the durable cursor", true);
    } catch (error: unknown) {
      if (options.signal.aborted) return lastSequence;
      const failure =
        error instanceof SessionStreamError
          ? error
          : new SessionStreamError("Event stream connection failed", true);
      if (!failure.retryable) {
        options.onStatus({
          phase: "failed",
          attempt,
          lastSequence,
          message: failure.message,
        });
        return lastSequence;
      }
      attempt += 1;
      const delayMs = serverRetryMs ?? retryDelay(baseRetryDelay, attempt);
      options.onStatus({
        phase: "reconnecting",
        attempt,
        lastSequence,
        retryInMs: delayMs,
        message: failure.message,
      });
      await wait(delayMs, options.signal);
    }
  }
  return lastSequence;
}
