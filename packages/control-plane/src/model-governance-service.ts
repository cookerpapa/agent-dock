import type { Database } from "@agent-dock/database";
import type {
  ModelGovernanceResource,
  ReplaceModelGovernanceRequest,
  RunUsageResource,
  SessionContextResource,
  UsageSummaryResource,
} from "@agent-dock/protocol";
import { sql, type Kysely } from "kysely";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

export class ModelGovernanceError extends Error {
  readonly code:
    "authorization_denied" | "not_found" | "invalid_request" | "governance_unavailable";

  constructor(code: ModelGovernanceError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "ModelGovernanceError";
    this.code = code;
  }
}

function safeInteger(value: string | number | bigint | null, name: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ModelGovernanceError("governance_unavailable", `${name} is invalid`);
  }
  return parsed;
}

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ModelGovernanceError("governance_unavailable", "Governance timestamp is invalid");
  }
  return parsed.toISOString();
}

function totals(row: {
  requests: string | number | bigint;
  input_tokens: string | number | bigint;
  output_tokens: string | number | bigint;
  cache_read_tokens: string | number | bigint;
  cache_write_tokens: string | number | bigint;
  cost_microusd: string | number | bigint;
}) {
  return {
    requests: safeInteger(row.requests, "usage request count"),
    inputTokens: safeInteger(row.input_tokens, "input token usage"),
    outputTokens: safeInteger(row.output_tokens, "output token usage"),
    cacheReadTokens: safeInteger(row.cache_read_tokens, "cache-read token usage"),
    cacheWriteTokens: safeInteger(row.cache_write_tokens, "cache-write token usage"),
    costMicrousd: safeInteger(row.cost_microusd, "usage cost"),
  };
}

const usageAggregate = sql<{
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cost_microusd: string;
}>`
  count(*) as requests,
  coalesce(sum(input_tokens), 0) as input_tokens,
  coalesce(sum(output_tokens), 0) as output_tokens,
  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
  coalesce(sum(cache_write_tokens), 0) as cache_write_tokens,
  coalesce(sum(coalesce(cost_microusd, round(cost_amount * 1000000)::bigint)), 0) as cost_microusd
`;

export class ModelGovernanceService {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: { database: Kysely<Database>; clock?: () => Date }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(identity: TenantRequestIdentity): Promise<ModelGovernanceResource> {
    const policy = await this.#database
      .selectFrom("tenant_runtime_policies as policy")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .leftJoin("model_routing_policies as route", (join) =>
        join
          .onRef("route.tenant_id", "=", "policy.tenant_id")
          .onRef("route.model_profile_id", "=", "policy.default_model_profile_id"),
      )
      .select([
        "policy.maximum_model_requests_per_run",
        "policy.maximum_cost_microusd_per_run",
        "policy.daily_token_budget",
        "policy.monthly_cost_microusd_budget",
        "policy.maximum_tool_calls_per_run",
        "policy.maximum_tool_output_bytes",
        "policy.maximum_run_duration_ms",
        "policy.compaction_reserve_tokens",
        "policy.compaction_keep_recent_tokens",
        "policy.updated_at",
        "profile.model_id as primaryModelId",
        "route.enabled as fallbackEnabled",
        "route.fallback_provider as fallbackProvider",
        "route.fallback_model_id as fallbackModelId",
        "route.fallback_on_rate_limit as fallbackOnRateLimit",
        "route.fallback_on_server_error as fallbackOnServerError",
        "route.fallback_on_timeout as fallbackOnTimeout",
      ])
      .where("policy.tenant_id", "=", identity.tenantId)
      .where("policy.enabled", "=", true)
      .executeTakeFirst();
    if (policy === undefined) {
      throw new ModelGovernanceError("governance_unavailable", "Model governance is unavailable");
    }
    const rates = await this.#database
      .selectFrom("model_rates")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .orderBy("provider", "asc")
      .orderBy("model_id", "asc")
      .execute();
    return {
      limits: {
        maximumModelRequestsPerRun: safeInteger(
          policy.maximum_model_requests_per_run,
          "model request limit",
        ),
        maximumCostMicrousdPerRun: safeInteger(
          policy.maximum_cost_microusd_per_run,
          "run cost limit",
        ),
        dailyTokenBudget: safeInteger(policy.daily_token_budget, "daily token budget"),
        monthlyCostMicrousdBudget: safeInteger(
          policy.monthly_cost_microusd_budget,
          "monthly cost budget",
        ),
        maximumToolCallsPerRun: policy.maximum_tool_calls_per_run,
        maximumToolOutputBytes: policy.maximum_tool_output_bytes,
        maximumRunDurationMs: policy.maximum_run_duration_ms,
        compactionReserveTokens: policy.compaction_reserve_tokens,
        compactionKeepRecentTokens: policy.compaction_keep_recent_tokens,
      },
      rates: rates.map((rate) => ({
        provider: rate.provider,
        modelId: rate.model_id,
        inputMicrousdPerMillion: safeInteger(rate.input_microusd_per_million, "input model rate"),
        outputMicrousdPerMillion: safeInteger(
          rate.output_microusd_per_million,
          "output model rate",
        ),
        cacheReadMicrousdPerMillion: safeInteger(
          rate.cache_read_microusd_per_million,
          "cache-read model rate",
        ),
        cacheWriteMicrousdPerMillion: safeInteger(
          rate.cache_write_microusd_per_million,
          "cache-write model rate",
        ),
      })),
      fallback: {
        enabled: policy.fallbackEnabled ?? false,
        ...(policy.fallbackProvider === null || policy.fallbackProvider === undefined
          ? {}
          : { provider: policy.fallbackProvider as "deepseek" }),
        ...(policy.fallbackModelId === null || policy.fallbackModelId === undefined
          ? {}
          : {
              modelId: policy.fallbackModelId as "deepseek-v4-flash" | "deepseek-v4-pro",
            }),
        onRateLimit: policy.fallbackOnRateLimit ?? true,
        onServerError: policy.fallbackOnServerError ?? true,
        onTimeout: policy.fallbackOnTimeout ?? true,
      },
      updatedAt: iso(policy.updated_at)!,
    };
  }

  async replace(
    identity: TenantRequestIdentity,
    request: ReplaceModelGovernanceRequest,
  ): Promise<ModelGovernanceResource> {
    if (identity.role !== "owner") {
      throw new ModelGovernanceError(
        "authorization_denied",
        "Only a tenant owner can replace model governance",
      );
    }
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError("Model governance clock returned an invalid date");
    }
    await this.#database.transaction().execute(async (transaction) => {
      const policy = await transaction
        .selectFrom("tenant_runtime_policies as policy")
        .innerJoin("model_profiles as profile", (join) =>
          join
            .onRef("profile.tenant_id", "=", "policy.tenant_id")
            .onRef("profile.id", "=", "policy.default_model_profile_id"),
        )
        .select([
          "policy.default_model_profile_id as profileId",
          "profile.provider as primaryProvider",
          "profile.model_id as primaryModelId",
        ])
        .where("policy.tenant_id", "=", identity.tenantId)
        .forUpdate("policy")
        .executeTakeFirst();
      if (policy === undefined) {
        throw new ModelGovernanceError("governance_unavailable", "Model governance is unavailable");
      }
      if (
        request.fallback.enabled &&
        request.fallback.provider === policy.primaryProvider &&
        request.fallback.modelId === policy.primaryModelId
      ) {
        throw new ModelGovernanceError(
          "invalid_request",
          "Fallback model must differ from the primary model",
        );
      }
      await transaction
        .updateTable("tenant_runtime_policies")
        .set({
          maximum_model_requests_per_run: request.limits.maximumModelRequestsPerRun,
          maximum_cost_microusd_per_run: request.limits.maximumCostMicrousdPerRun,
          daily_token_budget: request.limits.dailyTokenBudget,
          monthly_cost_microusd_budget: request.limits.monthlyCostMicrousdBudget,
          maximum_tool_calls_per_run: request.limits.maximumToolCallsPerRun,
          maximum_tool_output_bytes: request.limits.maximumToolOutputBytes,
          maximum_run_duration_ms: request.limits.maximumRunDurationMs,
          compaction_reserve_tokens: request.limits.compactionReserveTokens,
          compaction_keep_recent_tokens: request.limits.compactionKeepRecentTokens,
          updated_at: now,
        })
        .where("tenant_id", "=", identity.tenantId)
        .executeTakeFirstOrThrow();
      for (const rate of request.rates) {
        await transaction
          .insertInto("model_rates")
          .values({
            tenant_id: identity.tenantId,
            provider: rate.provider,
            model_id: rate.modelId,
            input_microusd_per_million: rate.inputMicrousdPerMillion,
            output_microusd_per_million: rate.outputMicrousdPerMillion,
            cache_read_microusd_per_million: rate.cacheReadMicrousdPerMillion,
            cache_write_microusd_per_million: rate.cacheWriteMicrousdPerMillion,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "provider", "model_id"]).doUpdateSet({
              input_microusd_per_million: rate.inputMicrousdPerMillion,
              output_microusd_per_million: rate.outputMicrousdPerMillion,
              cache_read_microusd_per_million: rate.cacheReadMicrousdPerMillion,
              cache_write_microusd_per_million: rate.cacheWriteMicrousdPerMillion,
              updated_at: now,
            }),
          )
          .execute();
      }
      if (request.fallback.enabled) {
        const configured = await transaction
          .selectFrom("model_rates")
          .select("model_id")
          .where("tenant_id", "=", identity.tenantId)
          .where("provider", "=", request.fallback.provider!)
          .where("model_id", "=", request.fallback.modelId!)
          .executeTakeFirst();
        if (configured === undefined) {
          throw new ModelGovernanceError(
            "invalid_request",
            "Fallback model requires an explicit rate configuration",
          );
        }
      }
      await transaction
        .insertInto("model_routing_policies")
        .values({
          tenant_id: identity.tenantId,
          model_profile_id: policy.profileId,
          fallback_provider: request.fallback.provider ?? null,
          fallback_model_id: request.fallback.modelId ?? null,
          fallback_on_rate_limit: request.fallback.onRateLimit,
          fallback_on_server_error: request.fallback.onServerError,
          fallback_on_timeout: request.fallback.onTimeout,
          enabled: request.fallback.enabled,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "model_profile_id"]).doUpdateSet({
            fallback_provider: request.fallback.provider ?? null,
            fallback_model_id: request.fallback.modelId ?? null,
            fallback_on_rate_limit: request.fallback.onRateLimit,
            fallback_on_server_error: request.fallback.onServerError,
            fallback_on_timeout: request.fallback.onTimeout,
            enabled: request.fallback.enabled,
            updated_at: now,
          }),
        )
        .execute();
    });
    return this.get(identity);
  }

  async usage(identity: TenantRequestIdentity): Promise<UsageSummaryResource> {
    const totalResult = await sql<{
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      cost_microusd: string;
    }>`select ${usageAggregate} from usage_ledger where tenant_id = ${identity.tenantId}`.execute(
      this.#database,
    );
    const byModel = await sql<{
      provider: string;
      model_id: string;
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      cost_microusd: string;
    }>`
      select provider, model_id, ${usageAggregate}
        from usage_ledger where tenant_id = ${identity.tenantId}
       group by provider, model_id order by provider, model_id
    `.execute(this.#database);
    return {
      tenantId: identity.tenantId,
      totals: totals(totalResult.rows[0]!),
      byModel: byModel.rows.map((row) => ({
        provider: row.provider,
        modelId: row.model_id,
        totals: totals(row),
      })),
    };
  }

  async runUsage(identity: TenantRequestIdentity, runId: string): Promise<RunUsageResource> {
    const run = await this.#database
      .selectFrom("runs")
      .select("id")
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", runId)
      .executeTakeFirst();
    if (run === undefined) throw new ModelGovernanceError("not_found", "Run was not found");
    const totalResult = await sql<{
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      cost_microusd: string;
    }>`
      select ${usageAggregate} from usage_ledger
       where tenant_id = ${identity.tenantId} and run_id = ${runId}
    `.execute(this.#database);
    const requests = await this.#database
      .selectFrom("model_requests")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("run_id", "=", runId)
      .orderBy("request_sequence", "asc")
      .execute();
    return {
      runId,
      totals: totals(totalResult.rows[0]!),
      modelRequests: requests.map((request) => {
        const actualTokens =
          request.actual_input_tokens === null || request.actual_output_tokens === null
            ? undefined
            : safeInteger(request.actual_input_tokens, "actual input tokens") +
              safeInteger(request.actual_output_tokens, "actual output tokens") +
              safeInteger(request.actual_cache_read_tokens, "actual cache-read tokens") +
              safeInteger(request.actual_cache_write_tokens, "actual cache-write tokens");
        return {
          requestId: request.id,
          sequence: request.request_sequence,
          state: request.state,
          requestedProvider: request.requested_provider,
          requestedModelId: request.requested_model_id,
          ...(request.actual_provider === null ? {} : { actualProvider: request.actual_provider }),
          ...(request.actual_model_id === null ? {} : { actualModelId: request.actual_model_id }),
          ...(request.fallback_reason === null ? {} : { fallbackReason: request.fallback_reason }),
          ...(request.failure_code === null ? {} : { failureCode: request.failure_code }),
          reservedTokens:
            safeInteger(request.reserved_input_tokens, "reserved input tokens") +
            safeInteger(request.reserved_output_tokens, "reserved output tokens"),
          ...(actualTokens === undefined ? {} : { actualTokens }),
          reservedCostMicrousd: safeInteger(
            request.reserved_cost_microusd,
            "reserved request cost",
          ),
          ...(request.actual_cost_microusd === null
            ? {}
            : {
                actualCostMicrousd: safeInteger(
                  request.actual_cost_microusd,
                  "actual request cost",
                ),
              }),
          ...(request.actual_input_microusd_per_million === null ||
          request.actual_output_microusd_per_million === null ||
          request.actual_cache_read_microusd_per_million === null ||
          request.actual_cache_write_microusd_per_million === null
            ? {}
            : {
                actualRate: {
                  inputMicrousdPerMillion: safeInteger(
                    request.actual_input_microusd_per_million,
                    "actual input rate",
                  ),
                  outputMicrousdPerMillion: safeInteger(
                    request.actual_output_microusd_per_million,
                    "actual output rate",
                  ),
                  cacheReadMicrousdPerMillion: safeInteger(
                    request.actual_cache_read_microusd_per_million,
                    "actual cache-read rate",
                  ),
                  cacheWriteMicrousdPerMillion: safeInteger(
                    request.actual_cache_write_microusd_per_million,
                    "actual cache-write rate",
                  ),
                },
              }),
          startedAt: iso(request.started_at)!,
          ...(request.settled_at === null ? {} : { settledAt: iso(request.settled_at)! }),
        };
      }),
    };
  }

  async sessionContext(
    identity: TenantRequestIdentity,
    sessionId: string,
  ): Promise<SessionContextResource> {
    const session = await this.#database
      .selectFrom("sessions")
      .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "sessions.tenant_id")
      .select(["policy.compaction_reserve_tokens", "policy.compaction_keep_recent_tokens"])
      .where("sessions.tenant_id", "=", identity.tenantId)
      .where("sessions.id", "=", sessionId)
      .executeTakeFirst();
    if (session === undefined) {
      throw new ModelGovernanceError("not_found", "Session was not found");
    }
    const rows = await this.#database
      .selectFrom("context_compactions")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("session_id", "=", sessionId)
      .orderBy("started_at", "desc")
      .limit(200)
      .execute();
    return {
      sessionId,
      compaction: {
        reserveTokens: session.compaction_reserve_tokens,
        keepRecentTokens: session.compaction_keep_recent_tokens,
      },
      layers: [
        { order: 0, kind: "platform_system", source: "pi+agent-dock", availability: "always" },
        {
          order: 1,
          kind: "project_instructions",
          source: "workspace:AGENTS.md",
          availability: "when_available",
          maximumBytes: 16_384,
        },
        {
          order: 2,
          kind: "session_summary",
          source: "pi-native-compaction",
          availability: "when_available",
        },
        {
          order: 3,
          kind: "recent_messages",
          source: "pi-session-jsonl",
          availability: "always",
        },
        {
          order: 4,
          kind: "tool_results",
          source: "bounded-tool-results",
          availability: "when_available",
        },
        { order: 5, kind: "current_task", source: "accepted-turn", availability: "always" },
      ],
      history: rows.map((row) => ({
        compactionId: row.id,
        turnId: row.turn_id,
        runId: row.run_id,
        attemptId: row.attempt_id,
        reason: row.reason,
        state: row.state,
        ...(row.tokens_before === null
          ? {}
          : { tokensBefore: safeInteger(row.tokens_before, "pre-compaction tokens") }),
        ...(row.estimated_tokens_after === null
          ? {}
          : {
              estimatedTokensAfter: safeInteger(
                row.estimated_tokens_after,
                "post-compaction tokens",
              ),
            }),
        ...(row.summary_sha256 === null ? {} : { summarySha256: row.summary_sha256 }),
        ...(row.summary_version === null ? {} : { summaryVersion: row.summary_version }),
        willRetry: row.will_retry,
        startedAt: iso(row.started_at)!,
        ...(row.completed_at === null ? {} : { completedAt: iso(row.completed_at)! }),
      })),
    };
  }
}
