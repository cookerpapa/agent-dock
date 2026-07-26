export class WorkspaceRuntimeError extends Error {
  readonly code = "invalid_workspace_snapshot";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRuntimeError";
  }
}
