import type { AgentDockEvent, AgentDockEventFactory } from "@agent-dock/protocol";

type JsonRecord = Record<string, unknown>;
type ApprovalKind = "confirm" | "select" | "input" | "editor";

type PendingApproval = {
  piRequestId: string;
  kind: ApprovalKind;
  options?: string[];
};

export type PiRpcAdapterOutcome =
  | { kind: "mapped"; event: AgentDockEvent }
  | { kind: "ignored"; sourceType: string; reason: string }
  | { kind: "unsupported"; sourceType: string; reason: string }
  | { kind: "invalid"; sourceType: string; reason: string };

export type ApprovalDecision = {
  approvalId: string;
  outcome: "approved" | "rejected" | "cancelled";
  value?: string;
};

export type PiExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type ResolvedApproval = {
  event: AgentDockEvent;
  piResponse: PiExtensionUiResponse;
};

export type PiRpcEventAdapterOptions = {
  approvalIdGenerator?: () => string;
};

export class PiRpcAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiRpcAdapterError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PiRpcAdapterError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PiRpcAdapterError(`${field} must be a string when present`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new PiRpcAdapterError(`${field} must be a positive safe integer when present`);
  }
  return value as number;
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]?: Value });
}

export class PiRpcEventAdapter {
  readonly #eventFactory: AgentDockEventFactory;
  readonly #approvalIdGenerator: () => string;
  readonly #pendingApprovals = new Map<string, PendingApproval>();

  constructor(eventFactory: AgentDockEventFactory, options: PiRpcEventAdapterOptions = {}) {
    this.#eventFactory = eventFactory;
    this.#approvalIdGenerator =
      options.approvalIdGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  get pendingApprovalCount(): number {
    return this.#pendingApprovals.size;
  }

  adaptOutput(value: unknown): PiRpcAdapterOutcome {
    if (!isRecord(value)) {
      return { kind: "invalid", sourceType: "unknown", reason: "Pi output must be a JSON object" };
    }

    const sourceType = typeof value.type === "string" ? value.type : "unknown";
    if (sourceType === "response") {
      return {
        kind: "ignored",
        sourceType,
        reason: "RPC command responses are correlated by the supervisor request table",
      };
    }

    if (sourceType !== "extension_ui_request") {
      return {
        kind: "unsupported",
        sourceType,
        reason: "No reviewed AgentDock v1 mapping exists for this Pi output type",
      };
    }

    const method = typeof value.method === "string" ? value.method : "unknown";
    try {
      switch (method) {
        case "confirm":
          return this.#adaptConfirm(value);
        case "select":
          return this.#adaptSelect(value);
        case "input":
          return this.#adaptInput(value);
        case "editor":
          return this.#adaptEditor(value);
        case "notify":
          return this.#adaptNotification(value);
        default:
          return {
            kind: "unsupported",
            sourceType: `extension_ui_request.${method}`,
            reason:
              "This fire-and-forget or TUI capability has not been mapped to a public v1 event",
          };
      }
    } catch (error: unknown) {
      return {
        kind: "invalid",
        sourceType: `extension_ui_request.${method}`,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  resolveApproval(decision: ApprovalDecision): ResolvedApproval {
    const pending = this.#pendingApprovals.get(decision.approvalId);
    if (pending === undefined) {
      throw new PiRpcAdapterError(`Unknown or already resolved approval: ${decision.approvalId}`);
    }

    const piResponse = this.#toPiResponse(pending, decision);
    const event = this.#eventFactory.next({
      type: "approval.resolved",
      payload: {
        approvalId: decision.approvalId,
        outcome: decision.outcome,
        ...optionalProperty("value", decision.value),
      },
    });
    this.#pendingApprovals.delete(decision.approvalId);
    return { event, piResponse };
  }

  #adaptConfirm(message: JsonRecord): PiRpcAdapterOutcome {
    const approvalId = this.#approvalIdGenerator();
    const piRequestId = requireString(message.id, "confirm.id");
    const title = requireString(message.title, "confirm.title");
    const promptMessage = requireString(message.message, "confirm.message");
    const timeoutMs = optionalPositiveInteger(message.timeout, "confirm.timeout");
    this.#assertCanRemember(approvalId, piRequestId);
    const event = this.#eventFactory.next({
      type: "approval.requested",
      payload: {
        approvalId,
        kind: "confirm",
        title,
        message: promptMessage,
        ...optionalProperty("timeoutMs", timeoutMs),
      },
    });
    this.#rememberApproval(approvalId, {
      piRequestId,
      kind: "confirm",
    });
    return { kind: "mapped", event };
  }

  #adaptSelect(message: JsonRecord): PiRpcAdapterOutcome {
    if (
      !Array.isArray(message.options) ||
      message.options.length === 0 ||
      !message.options.every((x) => typeof x === "string")
    ) {
      throw new PiRpcAdapterError("select.options must be a non-empty string array");
    }
    const options = [...message.options] as string[];
    const approvalId = this.#approvalIdGenerator();
    const piRequestId = requireString(message.id, "select.id");
    const title = requireString(message.title, "select.title");
    const timeoutMs = optionalPositiveInteger(message.timeout, "select.timeout");
    this.#assertCanRemember(approvalId, piRequestId);
    const event = this.#eventFactory.next({
      type: "approval.requested",
      payload: {
        approvalId,
        kind: "select",
        title,
        options,
        ...optionalProperty("timeoutMs", timeoutMs),
      },
    });
    this.#rememberApproval(approvalId, {
      piRequestId,
      kind: "select",
      options,
    });
    return { kind: "mapped", event };
  }

  #adaptInput(message: JsonRecord): PiRpcAdapterOutcome {
    const approvalId = this.#approvalIdGenerator();
    const piRequestId = requireString(message.id, "input.id");
    const title = requireString(message.title, "input.title");
    const placeholder = optionalString(message.placeholder, "input.placeholder");
    const timeoutMs = optionalPositiveInteger(message.timeout, "input.timeout");
    this.#assertCanRemember(approvalId, piRequestId);
    const event = this.#eventFactory.next({
      type: "approval.requested",
      payload: {
        approvalId,
        kind: "input",
        title,
        ...optionalProperty("placeholder", placeholder),
        ...optionalProperty("timeoutMs", timeoutMs),
      },
    });
    this.#rememberApproval(approvalId, {
      piRequestId,
      kind: "input",
    });
    return { kind: "mapped", event };
  }

  #adaptEditor(message: JsonRecord): PiRpcAdapterOutcome {
    const approvalId = this.#approvalIdGenerator();
    const piRequestId = requireString(message.id, "editor.id");
    const title = requireString(message.title, "editor.title");
    const initialValue = optionalString(message.prefill, "editor.prefill");
    this.#assertCanRemember(approvalId, piRequestId);
    const event = this.#eventFactory.next({
      type: "approval.requested",
      payload: {
        approvalId,
        kind: "editor",
        title,
        ...optionalProperty("initialValue", initialValue),
      },
    });
    this.#rememberApproval(approvalId, {
      piRequestId,
      kind: "editor",
    });
    return { kind: "mapped", event };
  }

  #adaptNotification(message: JsonRecord): PiRpcAdapterOutcome {
    const level = message.notifyType ?? "info";
    if (level !== "info" && level !== "warning" && level !== "error") {
      throw new PiRpcAdapterError("notify.notifyType must be info, warning, or error");
    }
    return {
      kind: "mapped",
      event: this.#eventFactory.next({
        type: "ui.notification",
        payload: {
          message: requireString(message.message, "notify.message"),
          level,
        },
      }),
    };
  }

  #assertCanRemember(approvalId: string, piRequestId: string): void {
    if (this.#pendingApprovals.has(approvalId)) {
      throw new PiRpcAdapterError(`Duplicate generated approval ID: ${approvalId}`);
    }
    for (const pending of this.#pendingApprovals.values()) {
      if (pending.piRequestId === piRequestId) {
        throw new PiRpcAdapterError(`Duplicate Pi UI request ID: ${piRequestId}`);
      }
    }
  }

  #rememberApproval(approvalId: string, approval: PendingApproval): void {
    this.#pendingApprovals.set(approvalId, approval);
  }

  #toPiResponse(pending: PendingApproval, decision: ApprovalDecision): PiExtensionUiResponse {
    if (decision.outcome === "cancelled") {
      return { type: "extension_ui_response", id: pending.piRequestId, cancelled: true };
    }

    if (pending.kind === "confirm") {
      if (decision.value !== undefined) {
        throw new PiRpcAdapterError("A confirm approval decision cannot include a value");
      }
      return {
        type: "extension_ui_response",
        id: pending.piRequestId,
        confirmed: decision.outcome === "approved",
      };
    }

    if (decision.outcome === "rejected") {
      if (decision.value !== undefined) {
        throw new PiRpcAdapterError("A rejected approval decision cannot include a value");
      }
      return { type: "extension_ui_response", id: pending.piRequestId, cancelled: true };
    }

    if (decision.value === undefined) {
      throw new PiRpcAdapterError(`${pending.kind} approval requires a value when approved`);
    }
    if (pending.kind === "select" && !pending.options?.includes(decision.value)) {
      throw new PiRpcAdapterError("Selected approval value was not one of the offered options");
    }
    return { type: "extension_ui_response", id: pending.piRequestId, value: decision.value };
  }
}
