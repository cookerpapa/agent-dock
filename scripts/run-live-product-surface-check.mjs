import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseWorkspaceTerminalServerFrame } from "../packages/protocol/src/index.ts";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import WebSocket from "ws";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_PRODUCT_SURFACE_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_PRODUCT_SURFACE_CHECK=1 to acknowledge real model and Cube usage",
  );
}

function parseEnvironment(value) {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Production environment file is invalid");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environment = parseEnvironment(await readFile(resolve(runtimeDirectory, ".env"), "utf8"));
const host =
  environment.PI_CLOUD_HTTP_BIND_ADDRESS === "0.0.0.0"
    ? "127.0.0.1"
    : environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (host === undefined || port === undefined) throw new Error("Production endpoint is missing");
const baseUrl = new URL(`http://${host}:${port}`);

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolvePromise();
    }
    signal?.addEventListener("abort", settle, { once: true });
  });
}

class BrowserCookieFetch {
  #cookie;

  get cookieHeader() {
    if (this.#cookie === undefined) throw new Error("Browser session cookie is unavailable");
    return this.#cookie;
  }

  fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (this.#cookie !== undefined) headers.set("cookie", this.#cookie);
    const response = await fetch(new URL(String(input), baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(300_000),
    });
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const match = /(?:^|[,;]\s*)(pi_cloud_session=[^;]*)/.exec(value);
      if (match === null) continue;
      this.#cookie = match[1] === "pi_cloud_session=" ? undefined : match[1];
    }
    return response;
  };
}

function progress(stage) {
  process.stdout.write(`[product-surface-check] ${stage}\n`);
}

async function waitForRun(api, runId, expectedStates, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (expectedStates.includes(run.state)) return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(
        `Run ended as ${run.state}${run.failure === undefined ? "" : `: ${run.failure.code}`}`,
      );
    }
    await wait(100);
  }
  throw new Error("Run did not settle before its API acceptance deadline");
}

async function runTurn({
  api,
  browser,
  sessionId,
  prompt,
  afterSequence,
  expectTools,
  expectedTerminal = "turn.completed",
  onToolStarted,
}) {
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const controller = new AbortController();
  const events = [];
  let terminal;
  let firstTextAt;
  let intervention;
  const timer = setTimeout(
    () => controller.abort(new Error("Product surface turn timed out")),
    180_000,
  );
  try {
    const cursor = await streamSessionEvents({
      sessionId,
      afterSequence,
      signal: controller.signal,
      fetchImplementation: browser.fetch,
      retryDelayMs: 100,
      onStatus() {},
      onEvent(event) {
        events.push(event);
        if (event.turnId !== accepted.turnId) return;
        if (event.type === "assistant.text.delta") firstTextAt ??= performance.now();
        if (event.type === "tool.started" && intervention === undefined && onToolStarted) {
          intervention = Promise.resolve(onToolStarted(accepted));
        }
        if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
          terminal = event;
          controller.abort();
        }
      },
    });
    await intervention;
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, expectedTerminal, JSON.stringify(terminal.payload));
    const toolCalls = events.filter(
      (event) => event.turnId === accepted.turnId && event.type === "tool.started",
    ).length;
    assert.equal(toolCalls > 0, expectTools, "Turn Tool behavior did not match its contract");
    const expectedRunState = expectedTerminal === "turn.cancelled" ? "cancelled" : "completed";
    await waitForRun(api, accepted.runId, [expectedRunState]);
    return {
      accepted,
      cursor,
      events,
      firstTextMs: firstTextAt === undefined ? undefined : Math.round(firstTextAt - submittedAt),
      settledMs: Math.round(performance.now() - submittedAt),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function expectApiStatus(operation, status) {
  await assert.rejects(
    operation,
    (error) => error instanceof PiCloudApiError && error.status === status,
  );
}

async function openTerminal(sessionId, cookieHeader) {
  const url = new URL(`/v1/conversations/${encodeURIComponent(sessionId)}/terminal`, baseUrl);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { cookie: cookieHeader } });
  let output = "";
  let ready = false;
  const terminal = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("Workspace terminal timed out")),
      90_000,
    );
    socket.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    socket.on("message", (value) => {
      try {
        const frame = parseWorkspaceTerminalServerFrame(JSON.parse(String(value)));
        if (frame.type === "workspace_terminal.error") {
          clearTimeout(timer);
          rejectPromise(new Error(`${frame.code}: ${frame.message}`));
          return;
        }
        if (frame.type === "workspace_terminal.ready") {
          ready = true;
          socket.send(
            JSON.stringify({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.input",
              data: Buffer.from("printf 'TERMINAL-SURFACE-OK\\n'\n", "utf8").toString("base64"),
            }),
          );
          return;
        }
        if (frame.type === "workspace_terminal.output") {
          output += Buffer.from(frame.data, "base64").toString("utf8");
          if (output.includes("TERMINAL-SURFACE-OK")) {
            socket.send(
              JSON.stringify({
                workspaceTerminalProtocolVersion: 1,
                type: "workspace_terminal.close",
              }),
            );
            clearTimeout(timer);
            resolvePromise({ ready, output });
          }
        }
      } catch (error) {
        clearTimeout(timer);
        rejectPromise(error);
      }
    });
  });
  try {
    return await terminal;
  } finally {
    socket.close();
  }
}

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const username = `surface-${suffix}`.slice(0, 48);
const password = `PiCloud acceptance ${suffix} 9!`;
const browser = new BrowserCookieFetch();
const api = new PiCloudApi(browser.fetch);
const createdSessionIds = new Set();
const createdWorkspaceIds = new Set();

try {
  progress("registering and authenticating through browser cookie APIs");
  const registration = await api.registerAccount(username, "Product Surface User", password);
  assert.equal(registration.identity.platformAdministrator, false);
  assert.equal((await api.getIdentity()).userId, registration.identity.userId);
  await api.logout();
  await expectApiStatus(api.getIdentity(), 401);
  const login = await api.loginAccount(username, password);
  assert.equal(login.identity.userId, registration.identity.userId);
  await expectApiStatus(api.getCubeProxyConfiguration(), 403);

  const project = await api.createProject(`Product surface ${suffix}`);
  createdWorkspaceIds.add(project.workspaceId);
  const session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Product surface ${suffix}`,
    "persistent",
  );
  createdSessionIds.add(session.sessionId);
  assert(
    (await api.listWorkspaces()).workspaces.some(
      (item) => item.workspaceId === project.workspaceId,
    ),
  );
  assert(
    (await api.listConversations()).conversations.some(
      (item) => item.sessionId === session.sessionId,
    ),
  );
  progress("workspace and conversation creation passed");

  let cursor = 0;
  const chat = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: "Do not call tools. Reply with exactly PRODUCT-SURFACE-CHAT-OK.",
    afterSequence: cursor,
    expectTools: false,
  });
  cursor = chat.cursor;
  const fullTree = await api.getConversationTree(session.sessionId, "full");
  const focusTree = await api.getConversationTree(session.sessionId, "focus");
  assert.equal(fullTree.currentSessionId, session.sessionId);
  assert.equal(focusTree.branches.length, 1);
  const parentBranch = fullTree.branches.find((branch) => branch.sessionId === session.sessionId);
  assert(parentBranch);
  const forkEntry = parentBranch.entries.find(
    (entry) => entry.turnId === chat.accepted.turnId && entry.finalAssistant,
  );
  assert(forkEntry, "Settled assistant entry was absent from the conversation tree");
  progress("pure chat, resumable SSE and tree projection passed");

  const fork = await api.forkConversation(
    session.sessionId,
    chat.accepted.turnId,
    forkEntry.entryId,
    `Product surface fork ${suffix}`,
    newIdempotencyKey("fork"),
  );
  createdSessionIds.add(fork.session.sessionId);
  const treeWithFork = await api.getConversationTree(fork.session.sessionId, "full");
  assert(treeWithFork.branches.some((branch) => branch.sessionId === session.sessionId));
  assert(treeWithFork.branches.some((branch) => branch.sessionId === fork.session.sessionId));
  await api.deleteConversation(fork.session.sessionId, newIdempotencyKey("delete"));
  assert(
    !(await api.listConversations()).conversations.some(
      (item) => item.sessionId === fork.session.sessionId,
    ),
  );
  progress("conversation fork and recursive branch deletion passed");

  const later = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: "Do not call tools. Reply with exactly PRODUCT-SURFACE-LATER-OK.",
    afterSequence: cursor,
    expectTools: false,
  });
  cursor = later.cursor;
  const prune = await api.pruneConversation(
    session.sessionId,
    chat.accepted.turnId,
    forkEntry.entryId,
    newIdempotencyKey("prune"),
  );
  assert(prune.prunedTurnCount >= 1);
  assert.equal((await api.getConversation(session.sessionId)).turns.length, 1);
  progress("settled-message tail pruning passed");

  const coding = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: [
      "Use tools in the current Workspace.",
      "Create surface_check.py containing a function add(a, b) and executable assertions for positive, negative and zero values.",
      "Run python3 surface_check.py and make it print exactly PRODUCT-SURFACE-CODE-OK.",
    ].join(" "),
    afterSequence: cursor,
    expectTools: true,
  });
  cursor = coding.cursor;
  const versions = await api.listWorkspaceVersions(session.sessionId);
  assert(versions.currentVersionId);
  const version = await api.getWorkspaceVersion(versions.currentVersionId);
  assert.equal(version.workspaceId, project.workspaceId);
  const files = await api.listWorkspaceFiles(version.versionId);
  assert(files.files.some((file) => file.path === "surface_check.py"));
  const source = await api.readWorkspaceFile(version.versionId, "surface_check.py");
  assert(Buffer.from(source.bytes).toString("utf8").includes("def add"));
  progress("real coding, Tool execution and Workspace source browsing passed");

  const terminal = await openTerminal(session.sessionId, browser.cookieHeader);
  assert.equal(terminal.ready, true);
  assert(terminal.output.includes("TERMINAL-SURFACE-OK"));
  progress("authenticated Workspace terminal passed");

  let steerAccepted = false;
  const steered = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt:
      "Use bash exactly once to run sleep 8. After it finishes, reply exactly OLD-STEER-TEXT.",
    afterSequence: cursor,
    expectTools: true,
    onToolStarted: async (accepted) => {
      const result = await api.steerTurn(
        session.sessionId,
        accepted.turnId,
        "Replace the requested final reply with exactly PRODUCT-SURFACE-STEER-OK.",
        newIdempotencyKey("steer"),
      );
      steerAccepted = result.state === "delivered";
    },
  });
  cursor = steered.cursor;
  assert.equal(steerAccepted, true);
  const afterSteer = await api.getConversation(session.sessionId);
  assert(JSON.stringify(afterSteer).includes("PRODUCT-SURFACE-STEER-OK"));
  progress("active Turn steer passed");

  let cancelAccepted = false;
  const cancelled = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: "Use bash exactly once to run sleep 60, then report completion.",
    afterSequence: cursor,
    expectTools: true,
    expectedTerminal: "turn.cancelled",
    onToolStarted: async (accepted) => {
      await api.cancelTurn(session.sessionId, accepted.turnId, newIdempotencyKey("cancel"), 250);
      cancelAccepted = true;
    },
  });
  cursor = cancelled.cursor;
  assert.equal(cancelAccepted, true);
  const recovery = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: "Do not call tools. Reply with exactly PRODUCT-SURFACE-RECOVERY-OK.",
    afterSequence: cursor,
    expectTools: false,
  });
  cursor = recovery.cursor;
  progress("cancellation and next-Turn interruption recovery passed");

  const archiveProject = await api.createProject(`Archive surface ${suffix}`);
  createdWorkspaceIds.add(archiveProject.workspaceId);
  const sibling = await api.createSession(
    archiveProject.projectId,
    archiveProject.workspaceId,
    `Archive surface ${suffix}`,
    "ephemeral",
  );
  createdSessionIds.add(sibling.sessionId);
  await api.archiveSession(sibling.sessionId, true, newIdempotencyKey("archive"));
  assert(
    !(await api.listConversations()).conversations.some(
      (item) => item.sessionId === sibling.sessionId,
    ),
  );
  await api.archiveSession(sibling.sessionId, false, newIdempotencyKey("archive"));
  assert(
    (await api.listConversations()).conversations.some(
      (item) => item.sessionId === sibling.sessionId,
    ),
  );
  progress("archive and unarchive passed");

  const foreignBrowser = new BrowserCookieFetch();
  const foreignApi = new PiCloudApi(foreignBrowser.fetch);
  await foreignApi.registerAccount(
    `foreign-${suffix}`.slice(0, 48),
    "Foreign Surface User",
    `${password} foreign`,
  );
  await expectApiStatus(foreignApi.getConversation(session.sessionId), 404);
  assert(
    !(await foreignApi.listWorkspaces()).workspaces.some(
      (workspace) => workspace.workspaceId === project.workspaceId,
    ),
  );
  progress("cross-tenant API isolation passed");

  await api.deleteConversation(sibling.sessionId, newIdempotencyKey("delete"));
  await api.deleteConversation(session.sessionId, newIdempotencyKey("delete"));
  const archiveDeletion = await api.deleteWorkspace(
    archiveProject.workspaceId,
    newIdempotencyKey("delete"),
  );
  assert.equal(archiveDeletion.workspaceId, archiveProject.workspaceId);
  const deletion = await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
  assert.equal(deletion.workspaceId, project.workspaceId);
  assert(
    !(await api.listWorkspaces()).workspaces.some(
      (workspace) => workspace.workspaceId === project.workspaceId,
    ),
  );
  progress("conversation and Workspace deletion passed");

  process.stdout.write(
    `${JSON.stringify({
      accepted: true,
      checkedAt: new Date().toISOString(),
      browserCookieAuth: true,
      pureChatFirstTextMs: chat.firstTextMs,
      codingFirstTextMs: coding.firstTextMs,
      codingSettledMs: coding.settledMs,
      treeForkPrune: true,
      workspaceFiles: files.files.length,
      terminal: true,
      steer: true,
      cancelAndRecover: true,
      archive: true,
      tenantIsolation: true,
      deletion: deletion.storageState,
      finalCursor: cursor,
    })}\n`,
  );
} finally {
  for (const sessionId of createdSessionIds) {
    await api.deleteConversation(sessionId, newIdempotencyKey("delete")).catch(() => undefined);
  }
  for (const workspaceId of createdWorkspaceIds) {
    await api.deleteWorkspace(workspaceId, newIdempotencyKey("delete")).catch(() => undefined);
  }
}
