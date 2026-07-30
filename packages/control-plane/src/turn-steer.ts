export type TurnSteerTarget = {
  commandId: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
};

export type TurnSteerRequest = {
  commandId: string;
  idempotencyKey: string;
  target: TurnSteerTarget;
  text: string;
};

export class TurnSteerBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean, ambiguous = false) {
    super(safeMessage);
    this.name = "TurnSteerBackendError";
    this.code = code;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}

export interface TurnSteerBackend {
  steer(request: TurnSteerRequest): Promise<void>;
}
