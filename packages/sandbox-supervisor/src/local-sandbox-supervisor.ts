import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type CommandAckMessage,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
} from "@agent-dock/protocol";
import { isDeepStrictEqual } from "node:util";
import type { PiRpcEventPublisher, PiRpcTurnResult } from "./pi-rpc-turn-runner.ts";

export interface SupervisorTurnRunner {
  run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiRpcEventPublisher,
  ): Promise<PiRpcTurnResult>;
}

export type PreparedTurnExecution = {
  ack: CommandAckMessage;
  run(): Promise<PiRpcTurnResult>;
  releaseBeforeStart(): void;
};

export type LocalSandboxSupervisorOptions = {
  runner: SupervisorTurnRunner;
  maxConcurrentSessions?: number;
  clock?: () => Date;
  idGenerator?: () => string;
};

type AssignmentState = "prepared" | "running" | "completed" | "failed" | "superseded";

type Assignment = {
  command: ExecuteTurnCommandMessage;
  publishEvent: (message: EventPublishMessage) => Promise<void> | void;
  state: AssignmentState;
  runPromise?: Promise<PiRpcTurnResult>;
};

export class LocalSandboxSupervisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalSandboxSupervisorError";
    this.code = code;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("supervisor clock must return a valid Date");
  }
  return value;
}

function sameIdentity(left: ExecuteTurnCommandMessage, right: ExecuteTurnCommandMessage): boolean {
  return isDeepStrictEqual(left.payload, right.payload);
}

export class LocalSandboxSupervisor {
  readonly #runner: SupervisorTurnRunner;
  readonly #maxConcurrentSessions: number;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #currentBySession = new Map<string, Assignment>();
  readonly #byCommand = new Map<string, Assignment>();
  readonly #highestFenceBySession = new Map<string, number>();

  constructor(options: LocalSandboxSupervisorOptions) {
    this.#runner = options.runner;
    this.#maxConcurrentSessions = positiveInteger(
      options.maxConcurrentSessions ?? 1,
      "maxConcurrentSessions",
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  get activeSessionCount(): number {
    return this.#currentBySession.size;
  }

  prepare(
    value: unknown,
    publishEvent: (message: EventPublishMessage) => Promise<void> | void,
  ): PreparedTurnExecution {
    const parsed = parseControlToSupervisorMessage(value);
    if (parsed.type !== "command.turn.execute") {
      throw new LocalSandboxSupervisorError(
        "unsupported",
        "Local supervisor only prepares turn.execute commands",
      );
    }
    const command = parsed;
    const duplicate = this.#byCommand.get(command.payload.commandId);
    if (duplicate !== undefined) {
      if (!sameIdentity(duplicate.command, command)) {
        return this.#rejected(command, "invalid_command", "Command identity changed", false);
      }
      return this.#prepared(duplicate, "duplicate");
    }

    if (command.payload.input.kind !== "prompt") {
      return this.#rejected(command, "unsupported", "Only prompt input is supported", false);
    }

    const highestFence = this.#highestFenceBySession.get(command.payload.sessionId) ?? 0;
    const current = this.#currentBySession.get(command.payload.sessionId);
    if (command.payload.fencingToken < highestFence) {
      return this.#rejected(command, "stale_fence", "Session assignment is stale", false);
    }
    if (command.payload.fencingToken === highestFence && highestFence > 0) {
      return this.#rejected(command, "stale_fence", "Session assignment is stale", false);
    }
    if (current === undefined && this.#currentBySession.size >= this.#maxConcurrentSessions) {
      return this.#rejected(command, "capacity", "Supervisor capacity is full", true);
    }

    if (current !== undefined) current.state = "superseded";
    const assignment: Assignment = {
      command,
      publishEvent,
      state: "prepared",
    };
    this.#highestFenceBySession.set(command.payload.sessionId, command.payload.fencingToken);
    this.#currentBySession.set(command.payload.sessionId, assignment);
    this.#byCommand.set(command.payload.commandId, assignment);
    return this.#prepared(assignment, "accepted");
  }

  #prepared(assignment: Assignment, status: "accepted" | "duplicate"): PreparedTurnExecution {
    return {
      ack: this.#ack(assignment.command, { status }),
      run: () => this.#run(assignment),
      releaseBeforeStart: () => this.#releaseBeforeStart(assignment),
    };
  }

  #rejected(
    command: ExecuteTurnCommandMessage,
    code: "stale_fence" | "invalid_state" | "capacity" | "invalid_command" | "unsupported",
    message: string,
    retryable: boolean,
  ): PreparedTurnExecution {
    return {
      ack: this.#ack(command, { status: "rejected", code, message, retryable }),
      run: () =>
        Promise.reject(new LocalSandboxSupervisorError(code, "Rejected command cannot run")),
      releaseBeforeStart: () => undefined,
    };
  }

  #ack(
    command: ExecuteTurnCommandMessage,
    result:
      | { status: "accepted" | "duplicate" }
      | {
          status: "rejected";
          code: "stale_fence" | "invalid_state" | "capacity" | "invalid_command" | "unsupported";
          message: string;
          retryable: boolean;
        },
  ): CommandAckMessage {
    const candidate = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: validDate(this.#clock).toISOString(),
      type: "command.ack",
      payload: {
        commandId: command.payload.commandId,
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        leaseId: command.payload.leaseId,
        fencingToken: command.payload.fencingToken,
        ...result,
      },
    });
    if (candidate.type !== "command.ack") {
      throw new LocalSandboxSupervisorError("invalid_ack", "Supervisor ACK was invalid");
    }
    return candidate;
  }

  #run(assignment: Assignment): Promise<PiRpcTurnResult> {
    if (assignment.runPromise !== undefined) return assignment.runPromise;
    const current = this.#currentBySession.get(assignment.command.payload.sessionId);
    if (current !== assignment || assignment.state !== "prepared") {
      return Promise.reject(
        new LocalSandboxSupervisorError("stale_fence", "Prepared assignment is no longer current"),
      );
    }
    assignment.state = "running";
    assignment.runPromise = this.#runner
      .run(assignment.command, async (message) => {
        const latest = this.#currentBySession.get(assignment.command.payload.sessionId);
        if (latest !== assignment || assignment.state !== "running") {
          throw new LocalSandboxSupervisorError(
            "stale_fence",
            "Stale assignment cannot publish events",
          );
        }
        if (
          message.payload.leaseId !== assignment.command.payload.leaseId ||
          message.payload.fencingToken !== assignment.command.payload.fencingToken ||
          message.payload.commandId !== assignment.command.payload.commandId
        ) {
          throw new LocalSandboxSupervisorError(
            "invalid_event",
            "Runner event identity does not match its assignment",
          );
        }
        await assignment.publishEvent(message);
      })
      .then(
        (result) => {
          assignment.state = "completed";
          return result;
        },
        (error: unknown) => {
          if (assignment.state !== "superseded") assignment.state = "failed";
          throw error;
        },
      )
      .finally(() => {
        if (this.#currentBySession.get(assignment.command.payload.sessionId) === assignment) {
          this.#currentBySession.delete(assignment.command.payload.sessionId);
        }
      });
    return assignment.runPromise;
  }

  #releaseBeforeStart(assignment: Assignment): void {
    if (assignment.state !== "prepared") return;
    if (this.#currentBySession.get(assignment.command.payload.sessionId) === assignment) {
      this.#currentBySession.delete(assignment.command.payload.sessionId);
    }
    this.#byCommand.delete(assignment.command.payload.commandId);
    assignment.state = "failed";
  }
}
