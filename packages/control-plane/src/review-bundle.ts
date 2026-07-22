import { createHash } from "node:crypto";
import type { Database } from "@agent-dock/database";
import {
  canonicalReviewBundleManifestJson,
  parseEnvironmentValidationReport,
  parseReviewBundleManifest,
  parseWorkspaceSourceSetSnapshot,
  type EnvironmentRuntimeSnapshot,
  type ReviewBundleManifest,
} from "@agent-dock/protocol";
import { sql, type Transaction } from "kysely";

const MAX_ASSISTANT_TEXT_LENGTH = 100_000;
const MAX_CHANGED_PATHS = 1_000;

export type CompletedRunReviewIdentity = {
  tenantId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  environment: EnvironmentRuntimeSnapshot;
};

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new TypeError("Review timestamp is invalid");
  return parsed.toISOString();
}

function safeInteger(value: string | number | bigint | null, description: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${description} is outside the safe integer range`);
  }
  return parsed;
}

function deterministicReviewBundleId(runId: string): string {
  const hex = createHash("sha256")
    .update("agent-dock.review-bundle.v1\0", "utf8")
    .update(runId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assistantText(events: readonly { seq: string; payload: Record<string, unknown> }[]) {
  const complete = events
    .map((event) => (typeof event.payload.text === "string" ? event.payload.text : ""))
    .join("");
  const truncated = complete.length > MAX_ASSISTANT_TEXT_LENGTH;
  const text = complete.slice(0, MAX_ASSISTANT_TEXT_LENGTH);
  return {
    text,
    textSha256: sha256(complete),
    ...(events.length === 0
      ? {}
      : {
          firstSeq: safeInteger(events[0]!.seq, "First assistant event sequence"),
          lastSeq: safeInteger(events.at(-1)!.seq, "Last assistant event sequence"),
        }),
    truncated,
  };
}

function changedPaths(patch: string | undefined): string[] {
  if (patch === undefined) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).split("\t", 1)[0] ?? "";
    if (raw === "/dev/null") continue;
    const path = raw.startsWith("b/") ? raw.slice(2) : raw;
    if (path.length < 1 || path.length > 1_024 || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= MAX_CHANGED_PATHS) break;
  }
  return paths;
}

function failure(
  code: string | null,
  message: string | null,
  retryable: boolean | null,
): { code: string; message?: string; retryable: boolean } | undefined {
  if (code === null && message === null && retryable === null) return undefined;
  if (code === null || retryable === null) throw new TypeError("Attempt failure is incomplete");
  return {
    code: code.slice(0, 128),
    ...(message === null ? {} : { message: message.slice(0, 1_024) }),
    retryable,
  };
}

export async function createCompletedRunReviewBundle(
  transaction: Transaction<Database>,
  identity: CompletedRunReviewIdentity,
  stopReason: string,
  now: Date,
): Promise<{ reviewBundleId: string; manifestSha256: string }> {
  const run = await transaction
    .selectFrom("runs")
    .select([
      "trace_id",
      "source_set_snapshot",
      "queued_at",
      "started_at",
      "settled_at",
      "current_attempt_id",
    ])
    .where("tenant_id", "=", identity.tenantId)
    .where("id", "=", identity.runId)
    .executeTakeFirstOrThrow();
  if (run.current_attempt_id !== identity.attemptId || run.settled_at === null) {
    throw new TypeError("Review bundle can only be created for the current settled Attempt");
  }

  const attempts = await transaction
    .selectFrom("run_attempts")
    .select([
      "id",
      "attempt_number",
      "state",
      "failure_code",
      "failure_message",
      "failure_retryable",
      "claimed_at",
      "settled_at",
      "lease_id",
      "fencing_token",
    ])
    .where("tenant_id", "=", identity.tenantId)
    .where("run_id", "=", identity.runId)
    .orderBy("attempt_number")
    .execute();
  const currentAttempt = attempts.find((attempt) => attempt.id === identity.attemptId);
  if (currentAttempt === undefined) throw new TypeError("Current Run Attempt is missing");

  let eventQuery = transaction
    .selectFrom("session_events")
    .select(["seq", "type", "payload"])
    .where("tenant_id", "=", identity.tenantId)
    .where("session_id", "=", identity.sessionId)
    .where("turn_id", "=", identity.turnId);
  if (currentAttempt.lease_id !== null && currentAttempt.fencing_token !== null) {
    eventQuery = eventQuery
      .where("lease_id", "=", currentAttempt.lease_id)
      .where("fencing_token", "=", currentAttempt.fencing_token);
  }
  const events = await eventQuery.orderBy("seq").execute();
  const assistantEvents = events.filter(
    (event): event is typeof event & { payload: Record<string, unknown> } =>
      event.type === "assistant.text.delta",
  );
  const terminal = [...events].reverse().find((event) => event.type === "turn.completed");
  const terminalPayload = terminal?.payload as Record<string, unknown> | undefined;
  const workspacePatch = terminalPayload?.workspacePatch as
    { patch?: unknown; truncated?: unknown } | undefined;
  const patch = typeof workspacePatch?.patch === "string" ? workspacePatch.patch : undefined;

  const workspaceVersion = await transaction
    .selectFrom("workspace_versions")
    .select(["id", "patch_artifact_id"])
    .where("tenant_id", "=", identity.tenantId)
    .where("run_id", "=", identity.runId)
    .where("attempt_id", "=", identity.attemptId)
    .where("state", "=", "settled")
    .executeTakeFirst();
  const artifacts = await transaction
    .selectFrom("artifacts")
    .select(["id", "kind", "file_name", "media_type", "sha256", "size_bytes", "created_at"])
    .where("tenant_id", "=", identity.tenantId)
    .where("run_id", "=", identity.runId)
    .orderBy("created_at")
    .orderBy("id")
    .limit(1_000)
    .execute();
  const patchArtifact = artifacts.find(
    (artifact) => artifact.id === workspaceVersion?.patch_artifact_id,
  );
  const tests = await transaction
    .selectFrom("test_results")
    .selectAll()
    .where("tenant_id", "=", identity.tenantId)
    .where("run_id", "=", identity.runId)
    .orderBy("created_at")
    .limit(100)
    .execute();
  const usage = await sql<{
    requests: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_write_tokens: string;
    cost_microusd: string;
  }>`
    select count(*) as requests,
           coalesce(sum(input_tokens), 0) as input_tokens,
           coalesce(sum(output_tokens), 0) as output_tokens,
           coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
           coalesce(sum(cache_write_tokens), 0) as cache_write_tokens,
           coalesce(sum(coalesce(cost_microusd, round(cost_amount * 1000000)::bigint)), 0)
             as cost_microusd
      from usage_ledger
     where tenant_id = ${identity.tenantId}
       and run_id = ${identity.runId}
       and attempt_id = ${identity.attemptId}
  `.execute(transaction);
  const usageRow = usage.rows[0]!;
  const validation = await transaction
    .selectFrom("environment_validations")
    .select(["status", "report", "failure_code", "validated_at"])
    .where("tenant_id", "=", identity.tenantId)
    .where("run_id", "=", identity.runId)
    .where("attempt_id", "=", identity.attemptId)
    .executeTakeFirst();
  const validationReport =
    validation?.report === null || validation?.report === undefined
      ? undefined
      : parseEnvironmentValidationReport(validation.report);
  const validationReportJson =
    validationReport === undefined ? undefined : JSON.stringify(validationReport);

  const manifest: ReviewBundleManifest = parseReviewBundleManifest({
    schemaVersion: 1,
    run: {
      runId: identity.runId,
      traceId: run.trace_id,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      stopReason,
      queuedAt: iso(run.queued_at),
      ...(run.started_at === null ? {} : { startedAt: iso(run.started_at) }),
      settledAt: iso(run.settled_at),
    },
    environment: identity.environment,
    sourceSet: parseWorkspaceSourceSetSnapshot(run.source_set_snapshot),
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.id,
      attemptNumber: attempt.attempt_number,
      state: attempt.state,
      projection: attempt.id === identity.attemptId ? "canonical" : "superseded",
      ...(failure(attempt.failure_code, attempt.failure_message, attempt.failure_retryable) ===
      undefined
        ? {}
        : {
            failure: failure(
              attempt.failure_code,
              attempt.failure_message,
              attempt.failure_retryable,
            )!,
          }),
      claimedAt: iso(attempt.claimed_at),
      ...(attempt.settled_at === null ? {} : { settledAt: iso(attempt.settled_at) }),
    })),
    assistant: assistantText(assistantEvents),
    changes: {
      ...(workspaceVersion === undefined ? {} : { workspaceVersionId: workspaceVersion.id }),
      ...(patchArtifact === undefined
        ? {}
        : { patchArtifactId: patchArtifact.id, patchSha256: patchArtifact.sha256 }),
      changedPaths: changedPaths(patch),
    },
    tests: tests.map((test) => ({
      testResultId: test.id,
      toolCallId: test.tool_call_id,
      suite: test.suite,
      command: test.command,
      status: test.status,
      ...(test.exit_code === null ? {} : { exitCode: test.exit_code }),
      ...(test.duration_ms === null ? {} : { durationMs: test.duration_ms }),
      ...(test.summary === null ? {} : { summary: test.summary.slice(0, 2_000) }),
      ...(test.artifact_id === null ? {} : { artifactId: test.artifact_id }),
    })),
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.id,
      kind: artifact.kind,
      ...(artifact.file_name === null ? {} : { fileName: artifact.file_name.slice(0, 512) }),
      ...(artifact.media_type === null ? {} : { mediaType: artifact.media_type.slice(0, 256) }),
      sha256: artifact.sha256,
      sizeBytes: safeInteger(artifact.size_bytes, "Artifact size"),
      createdAt: iso(artifact.created_at),
    })),
    usage: {
      requests: safeInteger(usageRow.requests, "Usage request count"),
      inputTokens: safeInteger(usageRow.input_tokens, "Input token usage"),
      outputTokens: safeInteger(usageRow.output_tokens, "Output token usage"),
      cacheReadTokens: safeInteger(usageRow.cache_read_tokens, "Cache-read token usage"),
      cacheWriteTokens: safeInteger(usageRow.cache_write_tokens, "Cache-write token usage"),
      costMicrousd: safeInteger(usageRow.cost_microusd, "Usage cost"),
    },
    ...(validation === undefined
      ? {}
      : {
          environmentValidation: {
            status: validation.status,
            ...(validationReport === undefined ? {} : { report: validationReport }),
            ...(validationReportJson === undefined
              ? {}
              : { reportSha256: sha256(validationReportJson) }),
            ...(validation.failure_code === null
              ? {}
              : { failureCode: validation.failure_code.slice(0, 128) }),
            validatedAt: iso(validation.validated_at),
          },
        }),
    createdAt: iso(now),
  });
  const canonical = canonicalReviewBundleManifestJson(manifest);
  const manifestSha256 = sha256(canonical);
  const reviewBundleId = deterministicReviewBundleId(identity.runId);
  await transaction
    .insertInto("review_bundles")
    .values({
      id: reviewBundleId,
      tenant_id: identity.tenantId,
      project_id: identity.projectId,
      workspace_id: identity.workspaceId,
      session_id: identity.sessionId,
      run_id: identity.runId,
      attempt_id: identity.attemptId,
      workspace_version_id: workspaceVersion?.id ?? null,
      manifest: sql<Record<string, unknown>>`${canonical}::jsonb`,
      manifest_sha256: manifestSha256,
      created_at: now,
    })
    .onConflict((conflict) => conflict.columns(["tenant_id", "run_id"]).doNothing())
    .executeTakeFirst();
  return { reviewBundleId, manifestSha256 };
}
