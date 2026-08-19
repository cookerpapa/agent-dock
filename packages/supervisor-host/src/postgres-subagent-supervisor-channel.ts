import { randomUUID } from "node:crypto";
import type { Database, SubagentSupervisorReason } from "@pi-cloud/database";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { sql, type Kysely } from "kysely";
import { Type } from "typebox";
import type { PostgresSubagentJobProvider } from "./postgres-subagent-job-provider.ts";

const MAX_MESSAGE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const CHILD_RESULT_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

export type CloudSupervisorRequest = Readonly<{
  requestId: string;
  executionId: string;
  reason: SubagentSupervisorReason;
  message: string;
  expectsReply: boolean;
  createdAt: string;
  expiresAt?: string;
  replyMessage?: string;
}>;

function boundedMessage(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`${label} is too large`);
  }
  return normalized;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resource(row: {
  id: string;
  executionId: string;
  reason: SubagentSupervisorReason;
  message: string;
  expectsReply: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  replyMessage: string | null;
}): CloudSupervisorRequest {
  return {
    requestId: row.id,
    executionId: row.executionId,
    reason: row.reason,
    message: row.message,
    expectsReply: row.expectsReply,
    createdAt: row.createdAt.toISOString(),
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt.toISOString() }),
    ...(row.replyMessage === null ? {} : { replyMessage: row.replyMessage }),
  };
}

export class PostgresSubagentSupervisorChannel {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async contact(
    input: {
      tenantId: string;
      childSessionId: string;
      childRunId: string;
      reason: SubagentSupervisorReason;
      message: string;
      interview?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<CloudSupervisorRequest> {
    const message = boundedMessage(input.message, "Supervisor message");
    const expectsReply = input.reason !== "progress_update";
    const requestId = randomUUID();
    const created = await this.#database.transaction().execute(async (transaction) => {
      const execution = await transaction
        .selectFrom("subagent_executions as execution")
        .innerJoin("runs as child_run", (join) =>
          join
            .onRef("child_run.tenant_id", "=", "execution.tenant_id")
            .onRef("child_run.id", "=", "execution.child_run_id"),
        )
        .select(["execution.id", "execution.state", "child_run.state as childRunState"])
        .where("execution.tenant_id", "=", input.tenantId)
        .where("execution.child_session_id", "=", input.childSessionId)
        .where("execution.child_run_id", "=", input.childRunId)
        .forUpdate(["execution"])
        .executeTakeFirst();
      if (
        execution === undefined ||
        (execution.state !== "running" && execution.childRunState !== "running")
      ) {
        throw new Error("Subagent execution is not running");
      }
      if (execution.state !== "running") {
        await transaction
          .updateTable("subagent_executions")
          .set({ state: "running", updated_at: new Date() })
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", execution.id)
          .executeTakeFirstOrThrow();
      }
      const expiresAt = expectsReply ? new Date(Date.now() + REQUEST_TIMEOUT_MS) : null;
      const row = await transaction
        .insertInto("subagent_supervisor_requests")
        .values({
          id: requestId,
          tenant_id: input.tenantId,
          execution_id: execution.id,
          reason: input.reason,
          message,
          interview: input.interview ?? null,
          expects_reply: expectsReply,
          reply_message: null,
          expires_at: expiresAt,
          replied_at: null,
        })
        .returning(["created_at as createdAt"])
        .executeTakeFirstOrThrow();
      return resource({
        id: requestId,
        executionId: execution.id,
        reason: input.reason,
        message,
        expectsReply,
        createdAt: row.createdAt,
        expiresAt,
        replyMessage: null,
      });
    });
    if (!expectsReply) return created;

    while (Date.now() < new Date(created.expiresAt!).valueOf()) {
      if (signal?.aborted) throw signal.reason;
      const current = await this.request(input.tenantId, requestId);
      if (current.replyMessage !== undefined) return current;
      await delay(POLL_MS, signal);
    }
    throw new Error("Timed out waiting for the parent Agent reply");
  }

  async request(tenantId: string, requestId: string): Promise<CloudSupervisorRequest> {
    const row = await this.#database
      .selectFrom("subagent_supervisor_requests")
      .select([
        "id",
        "execution_id as executionId",
        "reason",
        "message",
        "expects_reply as expectsReply",
        "created_at as createdAt",
        "expires_at as expiresAt",
        "reply_message as replyMessage",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    return resource(row);
  }

  async latestForExecution(
    tenantId: string,
    executionId: string,
  ): Promise<CloudSupervisorRequest | undefined> {
    const row = await this.#database
      .selectFrom("subagent_supervisor_requests")
      .select([
        "id",
        "execution_id as executionId",
        "reason",
        "message",
        "expects_reply as expectsReply",
        "created_at as createdAt",
        "expires_at as expiresAt",
        "reply_message as replyMessage",
      ])
      .where("tenant_id", "=", tenantId)
      .where("execution_id", "=", executionId)
      .where((expression) =>
        expression.or([
          expression("expects_reply", "=", false),
          expression.and([
            expression("reply_message", "is", null),
            expression("expires_at", ">", sql<Date>`now()`),
          ]),
        ]),
      )
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : resource(row);
  }

  async pendingForParent(
    tenantId: string,
    parentSessionId: string,
  ): Promise<CloudSupervisorRequest[]> {
    const rows = await this.#database
      .selectFrom("subagent_supervisor_requests as request")
      .innerJoin("subagent_executions as execution", (join) =>
        join
          .onRef("execution.tenant_id", "=", "request.tenant_id")
          .onRef("execution.id", "=", "request.execution_id"),
      )
      .select([
        "request.id",
        "request.execution_id as executionId",
        "request.reason",
        "request.message",
        "request.expects_reply as expectsReply",
        "request.created_at as createdAt",
        "request.expires_at as expiresAt",
        "request.reply_message as replyMessage",
      ])
      .where("request.tenant_id", "=", tenantId)
      .where("execution.parent_session_id", "=", parentSessionId)
      .where("request.expects_reply", "=", true)
      .where("request.reply_message", "is", null)
      .where("request.expires_at", ">", sql<Date>`now()`)
      .orderBy("request.created_at", "asc")
      .limit(100)
      .execute();
    return rows.map(resource);
  }

  async requestForParent(
    tenantId: string,
    parentSessionId: string,
    requestId: string,
  ): Promise<CloudSupervisorRequest> {
    const row = await this.#database
      .selectFrom("subagent_supervisor_requests as request")
      .innerJoin("subagent_executions as execution", (join) =>
        join
          .onRef("execution.tenant_id", "=", "request.tenant_id")
          .onRef("execution.id", "=", "request.execution_id"),
      )
      .select([
        "request.id",
        "request.execution_id as executionId",
        "request.reason",
        "request.message",
        "request.expects_reply as expectsReply",
        "request.created_at as createdAt",
        "request.expires_at as expiresAt",
        "request.reply_message as replyMessage",
      ])
      .where("request.tenant_id", "=", tenantId)
      .where("request.id", "=", requestId)
      .where("execution.parent_session_id", "=", parentSessionId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error("Supervisor request was not found for this parent Session");
    }
    return resource(row);
  }

  async reply(input: {
    tenantId: string;
    parentSessionId: string;
    requestId: string;
    message: string;
  }): Promise<CloudSupervisorRequest> {
    const message = boundedMessage(input.message, "Supervisor reply");
    await this.#database.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("subagent_supervisor_requests as request")
        .innerJoin("subagent_executions as execution", (join) =>
          join
            .onRef("execution.tenant_id", "=", "request.tenant_id")
            .onRef("execution.id", "=", "request.execution_id"),
        )
        .select([
          "request.reply_message as replyMessage",
          "request.expires_at as expiresAt",
          "execution.parent_session_id as parentSessionId",
        ])
        .where("request.tenant_id", "=", input.tenantId)
        .where("request.id", "=", input.requestId)
        .forUpdate(["request"])
        .executeTakeFirst();
      if (request === undefined || request.parentSessionId !== input.parentSessionId) {
        throw new Error("Supervisor request was not found for this parent Session");
      }
      if (request.replyMessage !== null) return;
      if (request.expiresAt === null || request.expiresAt.valueOf() <= Date.now()) {
        throw new Error("Supervisor request has expired");
      }
      await transaction
        .updateTable("subagent_supervisor_requests")
        .set({ reply_message: message, replied_at: new Date() })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.requestId)
        .where("reply_message", "is", null)
        .executeTakeFirstOrThrow();
    });
    return this.request(input.tenantId, input.requestId);
  }
}

const ContactSupervisorSchema = Type.Object(
  {
    reason: Type.Union([
      Type.Literal("need_decision"),
      Type.Literal("interview_request"),
      Type.Literal("progress_update"),
    ]),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
    interview: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export function createCloudContactSupervisorTool(options: {
  channel: PostgresSubagentSupervisorChannel;
  tenantId: string;
  childSessionId: string;
  childRunId: string;
}): AgentTool {
  return {
    name: "contact_supervisor",
    label: "Contact Supervisor",
    description:
      "Contact the parent/supervisor Agent for a blocking decision, structured interview, or meaningful progress update.",
    parameters: ContactSupervisorSchema,
    async execute(_toolCallId, raw, signal) {
      const input = raw as {
        reason: SubagentSupervisorReason;
        message?: string;
        interview?: Record<string, unknown>;
      };
      const request = await options.channel.contact(
        {
          tenantId: options.tenantId,
          childSessionId: options.childSessionId,
          childRunId: options.childRunId,
          reason: input.reason,
          message:
            input.message ??
            (input.reason === "interview_request"
              ? "The Subagent requests structured supervisor input."
              : "Subagent progress update."),
          ...(input.interview === undefined ? {} : { interview: input.interview }),
        },
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text:
              request.replyMessage === undefined
                ? "Supervisor progress update persisted."
                : `**Reply from supervisor:**\n${request.replyMessage}`,
          },
        ],
        details: { requestId: request.requestId, reason: request.reason },
      };
    },
  };
}

const SupervisorSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("pending"), Type.Literal("reply"), Type.Literal("wait")]),
    replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
  },
  { additionalProperties: false },
);

function toolText(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export function createCloudSubagentSupervisorTool(options: {
  channel: PostgresSubagentSupervisorChannel;
  jobs: PostgresSubagentJobProvider;
  tenantId: string;
  parentSessionId: string;
}): AgentTool {
  const waitForResult = async (
    request: CloudSupervisorRequest,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> => {
    const deadline = Date.now() + CHILD_RESULT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await options.jobs.result(options.tenantId, request.executionId);
      if (result.state === "completed") {
        return toolText(result.output ?? "Subagent completed without a text result.", {
          requestId: request.requestId,
          state: result.state,
        });
      }
      if (["failed", "cancelled", "unknown"].includes(result.state)) {
        return toolText(result.failureMessage ?? `Subagent ended in state ${result.state}.`, {
          requestId: request.requestId,
          state: result.state,
        });
      }
      await delay(POLL_MS, signal);
    }
    return toolText("Supervisor reply was delivered; the Subagent is still running.", {
      requestId: request.requestId,
      state: "running",
    });
  };

  return {
    name: "subagent_supervisor",
    label: "Subagent Supervisor",
    description:
      "Inspect and answer durable requests from cloud Subagents. Reply to blocking requests, then wait for the Child result.",
    parameters: SupervisorSchema,
    async execute(_toolCallId, raw, signal) {
      const input = raw as {
        action: "pending" | "reply" | "wait";
        replyTo?: string;
        message?: string;
      };
      if (input.action === "pending") {
        const pending = await options.channel.pendingForParent(
          options.tenantId,
          options.parentSessionId,
        );
        return toolText(
          pending.length === 0
            ? "No pending Subagent supervisor requests."
            : pending
                .map(
                  (request) =>
                    `${request.requestId}: ${request.reason}\n${request.message}\nReply with subagent_supervisor({ action: \"reply\", replyTo: \"${request.requestId}\", message: \"...\" }).`,
                )
                .join("\n\n"),
          {
            pending: pending.map(({ executionId: _executionId, ...request }) => request),
          },
        );
      }
      if (input.replyTo === undefined) throw new Error("replyTo is required");
      const request =
        input.action === "reply"
          ? await options.channel.reply({
              tenantId: options.tenantId,
              parentSessionId: options.parentSessionId,
              requestId: input.replyTo,
              message: boundedMessage(input.message, "Supervisor reply"),
            })
          : await options.channel.requestForParent(
              options.tenantId,
              options.parentSessionId,
              input.replyTo,
            );
      return waitForResult(request, signal);
    },
  };
}
