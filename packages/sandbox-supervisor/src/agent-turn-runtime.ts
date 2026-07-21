import type { AgentModelRuntime, ExecuteTurnCommandMessage } from "@agent-dock/protocol";

export type AgentTurnScenario =
  "text" | "java_repair" | "java_followup" | "coding_eval" | "tool_hold" | "timeout";

export type AgentTurnScenarioContext = {
  command: ExecuteTurnCommandMessage;
  restoring: boolean;
};

export type AgentTurnScenarioResolver = (context: AgentTurnScenarioContext) => AgentTurnScenario;

export type AgentWorkspaceSeedResolver = (
  command: ExecuteTurnCommandMessage,
  signal: AbortSignal,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

export type TrustedModelRuntimeLease = Readonly<{
  runtime: AgentModelRuntime;
  release(): Promise<void> | void;
}>;

export type TrustedModelRuntimeLeaseResolver = (
  command: ExecuteTurnCommandMessage,
) => Promise<TrustedModelRuntimeLease> | TrustedModelRuntimeLease;
