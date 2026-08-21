import {
  parseConversationTurnTranscriptResource,
  parsePiCloudEvent,
  type ConversationTurnTranscriptResource,
  type PiCloudEvent,
  type PiCloudEventBody,
} from "@pi-cloud/protocol";

type TerminalEventBody = Extract<PiCloudEventBody, { type: "turn.failed" | "turn.cancelled" }>;

export type PrepareTerminalTurnProjectionInput = Readonly<{
  tenantId: string;
  sessionId: string;
  turnId: string;
  commandId: string;
  agentId: string;
  body: TerminalEventBody;
  eventId: string;
  occurredAt: string;
}>;

export type PreparedTerminalTurnProjection = Readonly<{
  schemaVersion: 1;
  previousSequence: number;
  terminalEvent: PiCloudEvent;
  transcript: ConversationTurnTranscriptResource;
}>;

export interface TerminalTurnProjectionSource {
  prepare(input: PrepareTerminalTurnProjectionInput): Promise<PreparedTerminalTurnProjection>;
}

export const TERMINAL_TURN_PROJECTION_PATH = "/internal/v1/terminal-turn-projection";

export function parsePreparedTerminalTurnProjection(
  value: unknown,
): PreparedTerminalTurnProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prepared terminal projection is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.previousSequence) ||
    Number(candidate.previousSequence) < 0
  ) {
    throw new TypeError("Prepared terminal projection is invalid");
  }
  return {
    schemaVersion: 1,
    previousSequence: Number(candidate.previousSequence),
    terminalEvent: parsePiCloudEvent(candidate.terminalEvent),
    transcript: parseConversationTurnTranscriptResource(candidate.transcript),
  };
}

export class HttpTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #url: URL;
  readonly #authorization: string;
  readonly #timeoutMs: number;

  constructor(options: { baseUrl: string; serviceToken: string; timeoutMs?: number }) {
    this.#url = new URL(TERMINAL_TURN_PROJECTION_PATH, options.baseUrl);
    this.#authorization = `Bearer ${options.serviceToken}`;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async prepare(
    input: PrepareTerminalTurnProjectionInput,
  ): Promise<PreparedTerminalTurnProjection> {
    const deadline = Date.now() + this.#timeoutMs;
    let delayMs = 50;
    while (true) {
      try {
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { authorization: this.#authorization, "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now()))),
        });
        if (response.ok) return parsePreparedTerminalTurnProjection(await response.json());
        if (response.status < 500) {
          const rejected = new Error(
            `Terminal projection request was rejected with HTTP ${response.status}`,
          ) as Error & { retryable?: boolean };
          rejected.retryable = false;
          throw rejected;
        }
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "retryable" in error &&
          error.retryable === false
        ) {
          throw error;
        }
        if (Date.now() >= deadline) throw error;
      }
      if (Date.now() >= deadline) throw new Error("Terminal projection request timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }
}

/** Development fallback; production injects the Accepted Kafka projection. */
export class UnavailableTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  async prepare(_input: PrepareTerminalTurnProjectionInput): Promise<never> {
    throw new Error("No accepted live prefix is available in development composition");
  }
}
