import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDockApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.AGENT_DOCK_LIVE_GITHUB_CHECK !== "1") {
  throw new Error(
    "Set AGENT_DOCK_LIVE_GITHUB_CHECK=1 to acknowledge public GitHub access and real model usage",
  );
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.AGENT_DOCK_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environment = Object.fromEntries(
  (await readFile(resolve(runtimeDirectory, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const repository =
  process.env.AGENT_DOCK_LIVE_GITHUB_REPOSITORY ?? "mathewjonas/java-calculator-junit";
const commitSha =
  process.env.AGENT_DOCK_LIVE_GITHUB_COMMIT_SHA ?? "0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb";
if (
  !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(
    repository,
  ) ||
  repository.includes("..") ||
  repository.endsWith(".git") ||
  !/^[0-9a-f]{40}$/.test(commitSha)
) {
  throw new Error("Live GitHub repository source is invalid");
}
const bindAddress = environment.AGENT_DOCK_HTTP_BIND_ADDRESS;
const port = environment.AGENT_DOCK_HTTP_PORT;
const tenantId = environment.AGENT_DOCK_TENANT_ID;
if (bindAddress === undefined || port === undefined || tenantId === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const token = (await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8")).trim();
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);
const api = new AgentDockApi(fetchFromProduction, token);

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1_024 * 1_024, timeout: timeoutMs },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function psql(query) {
  return capture(process.execPath, [
    "scripts/production-compose.mjs",
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username",
    "agent_dock",
    "--dbname",
    "agent_dock",
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

async function runTurn(sessionId, prompt, afterSequence) {
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Live GitHub turn timed out")),
    600_000,
  );
  timer.unref();
  const events = [];
  let terminal;
  try {
    const cursor = await streamSessionEvents({
      sessionId,
      afterSequence,
      signal: controller.signal,
      authorizationToken: token,
      fetchImplementation: fetchFromProduction,
      retryDelayMs: 100,
      onStatus() {},
      onEvent(event) {
        events.push(event);
        if (
          event.turnId === accepted.turnId &&
          (event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled")
        ) {
          terminal = event;
          controller.abort();
        }
      },
    });
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    const patch = terminal.payload.workspacePatch?.patch;
    assert.equal(typeof patch, "string");
    assert(patch.length > 0, "Real Pi turn returned an empty workspace patch");
    assert(
      events.some((event) => event.type === "tool.started"),
      "Pi did not start a tool",
    );
    assert(
      events.some((event) => event.type === "tool.completed"),
      "Pi did not complete a tool",
    );
    return {
      accepted,
      cursor,
      eventCount: events.length,
      toolCalls: events.filter((event) => event.type === "tool.started").length,
      patchBytes: Buffer.byteLength(patch, "utf8"),
      patch,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");
const suffix = `${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
const project = await api.createProject(`GitHub import acceptance ${suffix}`, {
  kind: "github_public",
  repository,
  commitSha,
});
assert.equal(project.source.kind, "github_public");
assert.equal(project.source.status, "pending");
const session = await api.createSession(project);

const first = await runTurn(
  session.sessionId,
  [
    "Inspect this imported Java repository before editing it.",
    "Create a production Calculator at src/main/java/junit_project/Calculator.java with add, subtract, and multiply integer operations.",
    "Remove the duplicate Calculator implementation under src/test, and update the existing JUnit test to use the production class and cover multiplication.",
    "Add an executable test.sh that uses only the installed JDK (javac/java and a temporary output directory, without network or Maven downloads) to verify all three operations.",
    "Run ./test.sh and fix any failure. Do not edit generated target files. Make real file changes; do not only describe them.",
  ].join(" "),
  0,
);
const sourceAfterFirst = await psql(
  `select status || '|' || object_key || '|' || sha256 || '|' || size_bytes || '|' || updated_at::text
     from workspace_sources
    where tenant_id = ${sqlLiteral(tenantId)}
      and workspace_id = ${sqlLiteral(project.workspaceId)}`,
);
assert.match(sourceAfterFirst, /^ready\|[A-Za-z0-9/_.-]+\|[0-9a-f]{64}\|[1-9][0-9]*\|/);
assert(first.patch.includes("src/main/java/junit_project/Calculator.java"));
assert(first.patch.includes("test.sh"));

const second = await runTurn(
  session.sessionId,
  "Continue in the same workspace. Add divideExact(int dividend, int divisor), throw ArithmeticException for zero, extend test.sh to verify a successful division and the zero-divisor failure, then run ./test.sh. Preserve and build on the prior turn's changes.",
  first.cursor,
);
const sourceAfterSecond = await psql(
  `select status || '|' || object_key || '|' || sha256 || '|' || size_bytes || '|' || updated_at::text
     from workspace_sources
    where tenant_id = ${sqlLiteral(tenantId)}
      and workspace_id = ${sqlLiteral(project.workspaceId)}`,
);
assert.equal(
  sourceAfterSecond,
  sourceAfterFirst,
  "Follow-up turn unexpectedly re-imported the source",
);
assert(second.patch.includes("src/main/java/junit_project/Calculator.java"));
assert(second.patch.includes("test.sh"));

const conversation = await api.getConversation(session.sessionId);
assert.equal(conversation.project.source.kind, "github_public");
assert.equal(conversation.project.source.status, "ready");
assert.equal(conversation.turns.length, 2);
const usage = await psql(
  `select count(*) || '|' || coalesce(sum(input_tokens), 0) || '|' ||
          coalesce(sum(output_tokens), 0) || '|' || coalesce(sum(cache_read_tokens), 0) || '|' ||
          coalesce(sum(cache_write_tokens), 0)
     from usage_ledger
    where tenant_id = ${sqlLiteral(tenantId)}
      and session_id = ${sqlLiteral(session.sessionId)}`,
);
const [modelCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = usage
  .split("|")
  .map(Number);
assert(modelCalls > 0 && outputTokens > 0, "Real model token usage was not persisted");
const importers = await capture("docker", [
  "ps",
  "--all",
  "--filter",
  "label=agent-dock.workspace-import=true",
  "--format",
  "{{.ID}}",
]);
assert.equal(importers, "", "A repository importer container survived the acceptance run");

process.stdout.write(
  `${JSON.stringify({
    accepted: true,
    endpoint: baseUrl.toString(),
    model: { provider: model.provider, modelId: model.modelId },
    source: { repository, commitSha, status: conversation.project.source.status },
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
    firstTurn: {
      turnId: first.accepted.turnId,
      eventCount: first.eventCount,
      toolCalls: first.toolCalls,
      patchBytes: first.patchBytes,
    },
    secondTurn: {
      turnId: second.accepted.turnId,
      eventCount: second.eventCount,
      toolCalls: second.toolCalls,
      patchBytes: second.patchBytes,
    },
    usage: { modelCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    sourceSnapshot: sourceAfterSecond.split("|").slice(0, 4).join("|"),
  })}\n`,
);
