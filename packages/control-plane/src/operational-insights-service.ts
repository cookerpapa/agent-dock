import type { Database } from "@agent-dock/database";
import type {
  OperationalAuditEventResource,
  OperationalAuditLogResource,
  OperationalInsightsResource,
} from "@agent-dock/protocol";
import { sql, type Kysely } from "kysely";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

type RunAggregate = {
  queued: string;
  active: string;
  completed: string;
  failed: string;
  cancelled: string;
  timed_out: string;
  retried_attempts: string;
  queue_samples: string;
  queue_p50_ms: string | number | null;
  queue_p95_ms: string | number | null;
  execution_samples: string;
  execution_p50_ms: string | number | null;
  execution_p95_ms: string | number | null;
};

type ModelAggregate = {
  requests: string;
  failures: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cost_microusd: string;
};

type ToolAggregate = { calls: string; failures: string };
type QualityAggregate = { passed: string; failed: string; errored: string };

function integer(value: string | number | bigint | null, name: string): number {
  const parsed = value === null ? 0 : Number(value);
  const rounded = Math.round(parsed);
  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw new Error(`Operational insight ${name} is invalid`);
  }
  return rounded;
}

function timestamp(value: Date): string {
  if (Number.isNaN(value.valueOf())) throw new TypeError("Operational insight clock is invalid");
  return value.toISOString();
}

export class OperationalInsightsService {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: { database: Kysely<Database>; clock?: () => Date }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(identity: TenantRequestIdentity): Promise<OperationalInsightsResource> {
    const now = this.#clock();
    const since = new Date(now.valueOf() - 24 * 60 * 60_000);
    const [runsResult, modelResult, toolsResult, qualityResult, assignmentsResult, failures] =
      await Promise.all([
        sql<RunAggregate>`
          select
            count(*) filter (where state = 'queued') as queued,
            count(*) filter (where state in (
              'claimed', 'provisioning', 'restoring', 'running', 'checkpointing', 'cancel_requested'
            )) as active,
            count(*) filter (where state = 'completed' and settled_at >= ${since}) as completed,
            count(*) filter (where state = 'failed' and settled_at >= ${since}) as failed,
            count(*) filter (where state = 'cancelled' and settled_at >= ${since}) as cancelled,
            count(*) filter (where state = 'timed_out' and settled_at >= ${since}) as timed_out,
            coalesce(sum(greatest(attempt_count - 1, 0)) filter (where queued_at >= ${since}), 0)
              as retried_attempts,
            count(started_at) filter (where queued_at >= ${since}) as queue_samples,
            coalesce(percentile_cont(0.5) within group (
              order by extract(epoch from (started_at - queued_at)) * 1000
            ) filter (where queued_at >= ${since} and started_at is not null), 0) as queue_p50_ms,
            coalesce(percentile_cont(0.95) within group (
              order by extract(epoch from (started_at - queued_at)) * 1000
            ) filter (where queued_at >= ${since} and started_at is not null), 0) as queue_p95_ms,
            count(settled_at) filter (
              where settled_at >= ${since} and started_at is not null
            ) as execution_samples,
            coalesce(percentile_cont(0.5) within group (
              order by extract(epoch from (settled_at - started_at)) * 1000
            ) filter (where settled_at >= ${since} and started_at is not null), 0)
              as execution_p50_ms,
            coalesce(percentile_cont(0.95) within group (
              order by extract(epoch from (settled_at - started_at)) * 1000
            ) filter (where settled_at >= ${since} and started_at is not null), 0)
              as execution_p95_ms
          from runs where tenant_id = ${identity.tenantId}
        `.execute(this.#database),
        sql<ModelAggregate>`
          select
            (select count(*) from model_requests
              where tenant_id = ${identity.tenantId} and started_at >= ${since}) as requests,
            (select count(*) from model_requests
              where tenant_id = ${identity.tenantId} and started_at >= ${since}
                and state in ('failed', 'aborted')) as failures,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
            coalesce(sum(cache_write_tokens), 0) as cache_write_tokens,
            coalesce(sum(cost_microusd), 0) as cost_microusd
          from usage_ledger
          where tenant_id = ${identity.tenantId} and created_at >= ${since}
        `.execute(this.#database),
        sql<ToolAggregate>`
          select
            count(*) filter (where type = 'tool.started') as calls,
            count(*) filter (
              where type = 'tool.completed' and payload ->> 'isError' = 'true'
            ) as failures
          from session_events
          where tenant_id = ${identity.tenantId} and occurred_at >= ${since}
        `.execute(this.#database),
        sql<QualityAggregate>`
          select
            count(*) filter (where status = 'passed') as passed,
            count(*) filter (where status = 'failed') as failed,
            count(*) filter (where status = 'errored') as errored
          from test_results
          where tenant_id = ${identity.tenantId} and created_at >= ${since}
        `.execute(this.#database),
        sql<{ count: string }>`
          select count(distinct attempt.sandbox_id) as count
          from run_attempts as attempt
          inner join runs as run
            on run.tenant_id = attempt.tenant_id and run.id = attempt.run_id
          where run.tenant_id = ${identity.tenantId}
            and attempt.sandbox_id is not null
            and attempt.state in (
              'claimed', 'provisioning', 'restoring', 'running', 'checkpointing', 'cancel_requested'
            )
        `.execute(this.#database),
        this.#database
          .selectFrom("runs")
          .select(["failure_code as code"])
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", identity.tenantId)
          .where("settled_at", ">=", since)
          .where("failure_code", "is not", null)
          .groupBy("failure_code")
          .orderBy("count", "desc")
          .orderBy("failure_code", "asc")
          .limit(20)
          .execute(),
      ]);

    const runs = runsResult.rows[0]!;
    const model = modelResult.rows[0]!;
    const tools = toolsResult.rows[0]!;
    const quality = qualityResult.rows[0]!;
    const completed = integer(runs.completed, "completed Runs");
    const failed = integer(runs.failed, "failed Runs");
    const cancelled = integer(runs.cancelled, "cancelled Runs");
    const timedOut = integer(runs.timed_out, "timed-out Runs");
    const terminal = completed + failed + cancelled + timedOut;

    return {
      generatedAt: timestamp(now),
      windowStartedAt: timestamp(since),
      runs: {
        queued: integer(runs.queued, "queued Runs"),
        active: integer(runs.active, "active Runs"),
        completed,
        failed,
        cancelled,
        timedOut,
        retriedAttempts: integer(runs.retried_attempts, "retried attempts"),
        successRateBasisPoints: terminal === 0 ? 0 : Math.round((completed * 10_000) / terminal),
        queueWait: {
          sampleCount: integer(runs.queue_samples, "queue samples"),
          p50Ms: integer(runs.queue_p50_ms, "queue p50"),
          p95Ms: integer(runs.queue_p95_ms, "queue p95"),
        },
        execution: {
          sampleCount: integer(runs.execution_samples, "execution samples"),
          p50Ms: integer(runs.execution_p50_ms, "execution p50"),
          p95Ms: integer(runs.execution_p95_ms, "execution p95"),
        },
      },
      model: {
        requests: integer(model.requests, "model requests"),
        failures: integer(model.failures, "model failures"),
        inputTokens: integer(model.input_tokens, "input tokens"),
        outputTokens: integer(model.output_tokens, "output tokens"),
        cacheReadTokens: integer(model.cache_read_tokens, "cache-read tokens"),
        cacheWriteTokens: integer(model.cache_write_tokens, "cache-write tokens"),
        costMicrousd: integer(model.cost_microusd, "model cost"),
      },
      tools: {
        calls: integer(tools.calls, "tool calls"),
        failures: integer(tools.failures, "tool failures"),
      },
      quality: {
        testsPassed: integer(quality.passed, "passed tests"),
        testsFailed: integer(quality.failed, "failed tests"),
        testsErrored: integer(quality.errored, "errored tests"),
      },
      activeSandboxAssignments: integer(
        assignmentsResult.rows[0]?.count ?? "0",
        "active Sandbox assignments",
      ),
      failures: failures.map((failure) => ({
        code: failure.code!,
        count: integer(failure.count, "failure count"),
      })),
    };
  }

  async audit(identity: TenantRequestIdentity): Promise<OperationalAuditLogResource> {
    const limit = 101;
    const [attemptRows, workspaceRows, modelRows, githubRows] = await Promise.all([
      this.#database
        .selectFrom("run_attempt_transitions")
        .select(["id", "run_id", "to_state", "reason", "occurred_at"])
        .where("tenant_id", "=", identity.tenantId)
        .orderBy("occurred_at", "desc")
        .limit(limit)
        .execute(),
      this.#database
        .selectFrom("workspace_operations")
        .select(["id", "session_id", "kind", "from_version_id", "to_version_id", "created_at"])
        .where("tenant_id", "=", identity.tenantId)
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute(),
      this.#database
        .selectFrom("model_requests")
        .select([
          "id",
          "run_id",
          "state",
          "requested_provider",
          "requested_model_id",
          "actual_provider",
          "actual_model_id",
          "fallback_reason",
          "failure_code",
          "started_at",
          "settled_at",
        ])
        .where("tenant_id", "=", identity.tenantId)
        .orderBy("started_at", "desc")
        .limit(limit)
        .execute(),
      this.#database
        .selectFrom("github_pull_request_deliveries")
        .select([
          "id",
          "workspace_version_id",
          "state",
          "head_branch",
          "pull_request_number",
          "failure_code",
          "created_at",
          "updated_at",
        ])
        .where("tenant_id", "=", identity.tenantId)
        .orderBy("updated_at", "desc")
        .limit(limit)
        .execute(),
    ]);

    const events: OperationalAuditEventResource[] = [
      ...attemptRows.map((row) => ({
        eventId: row.id,
        category: "run_attempt" as const,
        action: `attempt.${row.to_state}`,
        state: row.to_state,
        subjectId: row.run_id,
        summary: row.reason,
        occurredAt: timestamp(row.occurred_at),
      })),
      ...workspaceRows.map((row) => ({
        eventId: row.id,
        category: "workspace" as const,
        action: `workspace.${row.kind}`,
        state: "committed",
        subjectId: row.session_id,
        summary: `version ${row.from_version_id ?? "none"} -> ${row.to_version_id ?? "none"}`,
        occurredAt: timestamp(row.created_at),
      })),
      ...modelRows.map((row) => ({
        eventId: row.id,
        category: "model" as const,
        action: "model.request",
        state: row.state,
        subjectId: row.run_id,
        summary: `${row.requested_provider}/${row.requested_model_id} -> ${row.actual_provider ?? "unsettled"}/${row.actual_model_id ?? "unsettled"}${row.fallback_reason === null ? "" : `; fallback=${row.fallback_reason}`}${row.failure_code === null ? "" : `; failure=${row.failure_code}`}`,
        occurredAt: timestamp(row.settled_at ?? row.started_at),
      })),
      ...githubRows.map((row) => ({
        eventId: row.id,
        category: "github" as const,
        action: "github.pull_request",
        state: row.state,
        subjectId: row.workspace_version_id,
        summary: `branch ${row.head_branch}${row.pull_request_number === null ? "" : `; PR #${String(row.pull_request_number)}`}${row.failure_code === null ? "" : `; failure=${row.failure_code}`}`,
        occurredAt: timestamp(row.updated_at ?? row.created_at),
      })),
    ];
    events.sort(
      (left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) ||
        right.eventId.localeCompare(left.eventId),
    );
    return {
      tenantId: identity.tenantId,
      events: events.slice(0, 100),
      truncated:
        events.length > 100 ||
        attemptRows.length === limit ||
        workspaceRows.length === limit ||
        modelRows.length === limit ||
        githubRows.length === limit,
    };
  }
}
