import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const SETTLEMENT_GATE_COMMAND_ID = "settlement-gate" as const;
export const PI_SETTLEMENT_GATE_CUSTOM_TYPE = "pi-cloud.settlement_gate" as const;

export type PiSettlementGatePolicy = Readonly<{
  command: string;
  cwd: string;
  timeoutMs: number;
  maximumFollowUps: 1;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastAssistantStopReason(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      typeof message.stopReason === "string"
    ) {
      return message.stopReason;
    }
  }
  return undefined;
}

function normalizedCommand(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isConfiguredVerification(command: string, policy: PiSettlementGatePolicy): boolean {
  const candidate = normalizedCommand(command);
  const verification = normalizedCommand(policy.command);
  if (policy.cwd === ".") return candidate === verification;
  return (
    candidate === `cd ${policy.cwd} && ${verification}` ||
    candidate === `cd -- ${policy.cwd} && ${verification}` ||
    candidate === `cd /workspace/${policy.cwd} && ${verification}` ||
    candidate === `cd -- /workspace/${policy.cwd} && ${verification}`
  );
}

export function settlementGatePolicyFromCommand(
  command: ExecuteTurnCommandMessage,
): PiSettlementGatePolicy | undefined {
  const configured = command.payload.environment.recipe.verificationCommands.find(
    (candidate) => candidate.id === SETTLEMENT_GATE_COMMAND_ID,
  );
  if (configured === undefined) return undefined;
  return Object.freeze({
    command: configured.command,
    cwd: configured.cwd,
    timeoutMs: configured.timeoutMs,
    maximumFollowUps: 1,
  });
}

function validatePolicy(policy: PiSettlementGatePolicy): PiSettlementGatePolicy {
  if (
    policy.maximumFollowUps !== 1 ||
    policy.command.trim().length === 0 ||
    policy.command.length > 4_096 ||
    !/^(?:\.|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/u.test(policy.cwd) ||
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 100 ||
    policy.timeoutMs > 300_000
  ) {
    throw new TypeError("Pi settlement gate policy is invalid");
  }
  return Object.freeze({ ...policy });
}

/**
 * Adds at most one Pi-native follow-up after a successful low-level run when
 * code may have changed and the project's explicit verification command was
 * not observed succeeding. The extension never executes a command itself.
 */
export function createPiSettlementGateExtension(input: PiSettlementGatePolicy): InlineExtension {
  const policy = validatePolicy(input);
  return (pi) => {
    let mutationObserved = false;
    let verificationSucceeded = false;
    let followUps = 0;
    const verificationCalls = new Set<string>();

    pi.on("tool_execution_start", (event) => {
      if (event.toolName === "write" || event.toolName === "edit") {
        mutationObserved = true;
        return;
      }
      if (event.toolName !== "bash") return;
      // Arbitrary shell can mutate the Workspace even when its text looks read-only.
      mutationObserved = true;
      if (
        isRecord(event.args) &&
        typeof event.args.command === "string" &&
        isConfiguredVerification(event.args.command, policy)
      ) {
        verificationCalls.add(event.toolCallId);
      }
    });

    pi.on("tool_execution_end", (event) => {
      if (verificationCalls.delete(event.toolCallId) && !event.isError) {
        verificationSucceeded = true;
      }
    });

    pi.on("agent_end", (event) => {
      const stopReason = lastAssistantStopReason(event.messages);
      if (
        !mutationObserved ||
        verificationSucceeded ||
        followUps >= policy.maximumFollowUps ||
        stopReason === undefined ||
        stopReason === "error" ||
        stopReason === "aborted"
      ) {
        return;
      }
      followUps += 1;
      const cwd = policy.cwd === "." ? "/workspace" : `/workspace/${policy.cwd}`;
      pi.sendMessage(
        {
          customType: PI_SETTLEMENT_GATE_CUSTOM_TYPE,
          content: [
            {
              type: "text",
              text: [
                "A project-defined verification step is still required before this Run settles.",
                `Run the configured command from ${cwd}, inspect its result, and address any failure before the final response.`,
                `Command: ${policy.command}`,
                `Timeout: ${String(Math.ceil(policy.timeoutMs / 1_000))} seconds`,
              ].join("\n"),
            },
          ],
          display: false,
          details: { schemaVersion: 1 },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    });
  };
}

/** Thin-runtime equivalent of the extension settlement gate. */
export class PiSettlementGateController {
  readonly #policy: PiSettlementGatePolicy;
  readonly #verificationCalls = new Set<string>();
  #mutationObserved = false;
  #verificationSucceeded = false;
  #lastStopReason: string | undefined;
  #used = false;

  constructor(input: PiSettlementGatePolicy) {
    this.#policy = validatePolicy(input);
  }

  observe(event: AgentEvent): void {
    if (event.type === "tool_execution_start") {
      if (event.toolName === "write" || event.toolName === "edit") {
        this.#mutationObserved = true;
        return;
      }
      if (event.toolName !== "bash") return;
      this.#mutationObserved = true;
      if (
        isRecord(event.args) &&
        typeof event.args.command === "string" &&
        isConfiguredVerification(event.args.command, this.#policy)
      ) {
        this.#verificationCalls.add(event.toolCallId);
      }
      return;
    }
    if (event.type === "tool_execution_end") {
      if (this.#verificationCalls.delete(event.toolCallId) && !event.isError) {
        this.#verificationSucceeded = true;
      }
      return;
    }
    if (event.type === "message_end" && isRecord(event.message)) {
      const reason = event.message.stopReason;
      if (typeof reason === "string") this.#lastStopReason = reason;
    }
  }

  prepareFollowUp(): AgentMessage | undefined {
    if (
      this.#used ||
      !this.#mutationObserved ||
      this.#verificationSucceeded ||
      this.#lastStopReason === undefined ||
      this.#lastStopReason === "error" ||
      this.#lastStopReason === "aborted"
    ) {
      return undefined;
    }
    this.#used = true;
    const cwd = this.#policy.cwd === "." ? "/workspace" : `/workspace/${this.#policy.cwd}`;
    return {
      role: "custom",
      customType: PI_SETTLEMENT_GATE_CUSTOM_TYPE,
      content: [
        {
          type: "text",
          text: [
            "A project-defined verification step is still required before this Run settles.",
            `Run the configured command from ${cwd}, inspect its result, and address any failure before the final response.`,
            `Command: ${this.#policy.command}`,
            `Timeout: ${String(Math.ceil(this.#policy.timeoutMs / 1_000))} seconds`,
          ].join("\n"),
        },
      ],
      display: false,
      details: { schemaVersion: 1 },
      timestamp: Date.now(),
    } as AgentMessage;
  }
}
