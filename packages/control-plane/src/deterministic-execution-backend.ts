import {
  TurnExecutionBackendError,
  type TurnExecutionBackend,
  type TurnExecutionLifecycle,
  type TurnExecutionRequest,
  type TurnExecutionResult,
} from "./run-command-executor.ts";

export type DeterministicExecutionOutcome =
  | { kind: "complete"; stopReason?: string }
  | {
      kind: "fail_before_start";
      code?: string;
      safeMessage?: string;
      retryable?: boolean;
    }
  | {
      kind: "fail_after_start";
      code?: string;
      safeMessage?: string;
      retryable?: boolean;
    };

export type DeterministicExecutionRecord = {
  commandId: string;
  sessionId: string;
  turnId: string;
  outcome: DeterministicExecutionOutcome["kind"];
};

export class DeterministicExecutionBackend implements TurnExecutionBackend {
  readonly #outcomes: DeterministicExecutionOutcome[];
  readonly #records: DeterministicExecutionRecord[] = [];

  constructor(outcomes: readonly DeterministicExecutionOutcome[] = []) {
    this.#outcomes = [...outcomes];
  }

  get records(): readonly DeterministicExecutionRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  async execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
  ): Promise<TurnExecutionResult> {
    const outcome = this.#outcomes.shift() ?? { kind: "complete" };
    this.#records.push({
      commandId: request.commandId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      outcome: outcome.kind,
    });

    if (outcome.kind === "fail_before_start") {
      throw new TurnExecutionBackendError(
        outcome.code ?? "runner_unavailable",
        outcome.safeMessage ?? "Execution runner was unavailable before start",
        outcome.retryable ?? true,
      );
    }

    await lifecycle.started();
    if (outcome.kind === "fail_after_start") {
      throw new TurnExecutionBackendError(
        outcome.code ?? "model_call_failed",
        outcome.safeMessage ?? "Execution failed after start",
        outcome.retryable ?? true,
      );
    }

    return { stopReason: outcome.stopReason ?? "agent_end" };
  }
}
