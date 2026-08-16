import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";

export type RunAttemptExecutionPhase = "restoring" | "running" | "checkpointing";

/**
 * A trusted, fail-closed persistence boundary for execution phases. The tool
 * sandbox never receives this capability or any database credentials.
 */
export interface RunAttemptPhaseObserver {
  transition(command: ExecuteTurnCommandMessage, phase: RunAttemptExecutionPhase): Promise<void>;
  checkpointCommitted(command: ExecuteTurnCommandMessage, revision: string): Promise<void>;
}
