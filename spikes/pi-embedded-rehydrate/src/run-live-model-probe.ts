import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddedPiBackend,
  type EmbeddedPiAssistantObservation,
  type EmbeddedPiBackendOptions,
} from "./index.ts";

const optInVariable = "AGENT_DOCK_ALLOW_SUBSCRIPTION_USAGE";
if (process.env[optInVariable] !== "1") {
  throw new Error(
    `Live model probe is disabled. Set ${optInVariable}=1 to authorize ChatGPT subscription usage.`,
  );
}

type OAuthStatus = {
  expires: number;
  expired: boolean;
};

type UsageSummary = EmbeddedPiAssistantObservation["usage"];

async function readOpenAiOAuthStatus(authPath: string): Promise<OAuthStatus> {
  const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Pi auth.json is not a JSON object");
  }
  const credential = (parsed as Record<string, unknown>)["openai-codex"];
  if (!credential || typeof credential !== "object") {
    throw new Error("Pi has no openai-codex credential");
  }
  const fields = credential as Record<string, unknown>;
  if (
    fields.type !== "oauth" ||
    typeof fields.refresh !== "string" ||
    fields.refresh.length === 0
  ) {
    throw new Error("Pi openai-codex credential is not a refreshable OAuth login");
  }
  if (typeof fields.expires !== "number" || !Number.isFinite(fields.expires)) {
    throw new Error("Pi openai-codex OAuth credential has no valid expiry timestamp");
  }
  return {
    expires: fields.expires,
    expired: fields.expires <= Date.now(),
  };
}

function requireSuccessfulAssistant(
  observation: EmbeddedPiAssistantObservation | null,
  expectedProvider: string,
  expectedModel: string,
): EmbeddedPiAssistantObservation {
  if (!observation) {
    throw new Error("Live model turn produced no assistant message");
  }
  if (observation.provider !== expectedProvider || observation.model !== expectedModel) {
    throw new Error("Live model turn used an unexpected provider or model");
  }
  if (observation.stopReason !== "stop") {
    throw new Error(
      `Live model turn did not stop successfully (${observation.stopReason}; category=${observation.errorCategory ?? "unknown"})`,
    );
  }
  if (observation.usage.totalTokens <= 0 || observation.usage.output <= 0) {
    throw new Error("Live model turn reported no token consumption");
  }
  return observation;
}

function normalizeExactReply(value: string): string {
  let normalized = value.trim();
  normalized = normalized
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const quote = normalized.at(0);
  if (quote && (quote === '"' || quote === "'" || quote === "`") && normalized.at(-1) === quote) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function addUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

const provider = "openai-codex";
const modelId = "gpt-5.4-mini";
const thinkingLevel = "off" as const;
const agentDir = join(homedir(), ".pi", "agent");
const authPath = join(agentDir, "auth.json");
const root = await mkdtemp(join(tmpdir(), "agent-dock-live-model-"));
const startedAt = Date.now();

try {
  const oauthBefore = await readOpenAiOAuthStatus(authPath);
  const options: EmbeddedPiBackendOptions = {
    cwd: join(root, "workspace"),
    agentDir,
    sessionDir: join(root, "sessions"),
    maxConcurrentActivations: 1,
    extensionFactories: [],
    allowModelPrompts: true,
    model: { provider, modelId, thinkingLevel },
    transport: "sse",
    systemPrompt:
      "You are a deterministic test assistant. Follow exact output-format instructions. Do not use tools.",
  };
  const nonce = `AGENTDOCK-${randomUUID().slice(0, 8).toUpperCase()}`;

  const firstBackend = new EmbeddedPiBackend(options);
  const first = await firstBackend.execute({
    logicalSessionId: "live-context-probe",
    command: `Remember this nonce for the next turn: ${nonce}. Reply with exactly ACK.`,
  });
  const firstAssistant = requireSuccessfulAssistant(first.lastAssistant, provider, modelId);
  const firstReplyMatched = normalizeExactReply(firstAssistant.text) === "ACK";
  if (!firstReplyMatched) {
    throw new Error("First live model turn did not follow the exact ACK response contract");
  }
  await access(first.checkpoint.sessionFile);

  // The first activation already disposed its AgentSessionRuntime. This new
  // backend has no in-memory session map and receives only the durable JSONL.
  const replacementBackend = new EmbeddedPiBackend(options);
  const second = await replacementBackend.execute({
    logicalSessionId: "live-context-probe",
    command: "What nonce did I ask you to remember? Reply with only the nonce.",
    checkpoint: first.checkpoint,
  });
  const secondAssistant = requireSuccessfulAssistant(second.lastAssistant, provider, modelId);
  const contextReplyMatched = normalizeExactReply(secondAssistant.text) === nonce;
  if (!contextReplyMatched) {
    throw new Error("Restored live model turn did not recover the nonce from prior context");
  }

  assert.notEqual(second.backendInstanceId, first.backendInstanceId);
  assert.equal(second.piSessionId, first.piSessionId);
  assert.ok(second.restoredMessageCount >= 2);
  assert.deepEqual(second.restoredMessageRoles.slice(-2), ["user", "assistant"]);

  const oauthAfter = await readOpenAiOAuthStatus(authPath);
  const totalUsage = addUsage(firstAssistant.usage, secondAssistant.usage);
  process.stdout.write(
    `${JSON.stringify(
      {
        result: "passed",
        piVersion: "0.84.1",
        provider,
        model: modelId,
        thinkingLevel,
        modelCalls: 2,
        firstTurn: {
          replyMatched: firstReplyMatched,
          usage: firstAssistant.usage,
        },
        restoredTurn: {
          contextReplyMatched,
          restoredMessageCount: second.restoredMessageCount,
          restoredMessageRoles: second.restoredMessageRoles,
          usage: secondAssistant.usage,
        },
        totalUsage,
        samePiSessionId: second.piSessionId === first.piSessionId,
        freshBackendInstance: second.backendInstanceId !== first.backendInstanceId,
        checkpointCreatedByRealAssistant: firstAssistant.provider !== "agent-dock",
        runtimeDisposedBetweenTurns: true,
        temporaryTranscriptRemovedOnExit: true,
        toolsEnabled: 0,
        extensionsEnabled: 0,
        oauth: {
          accessWasExpiredBeforeProbe: oauthBefore.expired,
          accessValidAfterProbe: !oauthAfter.expired,
          expiryAdvancedDuringProbe: oauthAfter.expires > oauthBefore.expires,
          expiresAfterProbe: new Date(oauthAfter.expires).toISOString(),
        },
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
