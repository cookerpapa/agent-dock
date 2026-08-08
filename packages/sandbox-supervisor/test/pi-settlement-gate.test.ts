import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  PI_SETTLEMENT_GATE_CUSTOM_TYPE,
  createPiSettlementGateExtension,
  settlementGatePolicyFromCommand,
} from "../src/index.ts";

function install() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const sendMessage = vi.fn();
  const extension = createPiSettlementGateExtension({
    command: "npm test",
    cwd: ".",
    timeoutMs: 120_000,
    maximumFollowUps: 1,
  });
  if (typeof extension !== "function") throw new Error("Expected inline extension factory");
  extension({
    on(name: string, handler: (event: unknown) => unknown) {
      handlers.set(name, handler);
    },
    sendMessage,
  } as unknown as ExtensionAPI);
  return { handlers, sendMessage };
}

function emit(
  handlers: Map<string, (event: unknown) => unknown>,
  name: string,
  event: Record<string, unknown>,
): void {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`Missing ${name} handler`);
  handler({ type: name, ...event });
}

describe("Pi settlement gate", () => {
  it("is absent by default and is enabled only by the named project recipe command", () => {
    const base = {
      payload: { environment: { recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE } },
    } as unknown as ExecuteTurnCommandMessage;
    expect(settlementGatePolicyFromCommand(base)).toBeUndefined();

    const configured = {
      payload: {
        environment: {
          recipe: {
            ...DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
            verificationCommands: [
              ...DEFAULT_PROJECT_ENVIRONMENT_RECIPE.verificationCommands,
              {
                id: "settlement-gate",
                command: "npm test",
                cwd: ".",
                timeoutMs: 120_000,
                network: "none",
              },
            ],
          },
        },
      },
    } as unknown as ExecuteTurnCommandMessage;
    expect(settlementGatePolicyFromCommand(configured)).toEqual({
      command: "npm test",
      cwd: ".",
      timeoutMs: 120_000,
      maximumFollowUps: 1,
    });
  });

  it("queues exactly one Pi-native follow-up after a mutating run without verification", () => {
    const { handlers, sendMessage } = install();
    emit(handlers, "tool_execution_start", {
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "src/index.ts", content: "export {};" },
    });
    emit(handlers, "tool_execution_end", {
      toolCallId: "write-1",
      toolName: "write",
      result: {},
      isError: false,
    });
    emit(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    expect(sendMessage).not.toHaveBeenCalled();

    emit(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    emit(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: PI_SETTLEMENT_GATE_CUSTOM_TYPE,
        display: false,
        details: { schemaVersion: 1 },
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(JSON.stringify(sendMessage.mock.calls)).toContain("npm test");
  });

  it("settles immediately when the configured verification already succeeded", () => {
    const { handlers, sendMessage } = install();
    emit(handlers, "tool_execution_start", {
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    emit(handlers, "tool_execution_end", {
      toolCallId: "bash-1",
      toolName: "bash",
      result: {},
      isError: false,
    });
    emit(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
