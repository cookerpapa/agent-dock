import type {
  CancelTurnCommandMessage,
  EventPublishMessage,
  WorkspacePatch,
} from "@pi-cloud/protocol";

export type PiModelRuntimeConfig = {
  provider: string;
  modelId: string;
  baseUrl: string;
  api: "openai-completions";
  apiKey: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export type PiToolOutputCapture = {
  toolCallId: string;
  bytes: Uint8Array;
};

export type PiToolOutputArtifact = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
};

export type PiTurnResult = {
  stopReason: string;
  workspacePatch?: WorkspacePatch;
  /** Highest Agent event durably acknowledged by the Kafka raw topic. */
  lastEventSeq?: number;
};

export type PiCancellationSignal = {
  kind: "pi-cloud.turn-cancellation";
  reason: CancelTurnCommandMessage["payload"]["reason"];
  gracePeriodMs: number;
};

export type PiEventPublisher = (message: EventPublishMessage) => Promise<void> | void;

export const PINNED_PI_CODING_AGENT_VERSION = "0.84.1";

export class PiTurnError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "PiTurnError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class PiTurnCancelledError extends PiTurnError {
  readonly reason: PiCancellationSignal["reason"];
  readonly forced: boolean;

  constructor(reason: PiCancellationSignal["reason"], forced: boolean) {
    super("turn_cancelled", "Turn cancellation was confirmed", false);
    this.name = "PiTurnCancelledError";
    this.reason = reason;
    this.forced = forced;
  }
}
