import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TenantIdentityResource } from "@agent-dock/protocol";
import { AgentDockApi, AgentDockApiError, newIdempotencyKey } from "./api.ts";
import {
  activeTurn,
  createInitialSessionView,
  sessionViewReducer,
  type TranscriptItem,
  type TurnView,
  type TurnViewStatus,
} from "./session-view.ts";
import { streamSessionEvents } from "./sse.ts";

const DEFAULT_PROMPT = "Run the tests, repair the Java bug, and verify the result.";
const MIN_SIDEBAR_WIDTH = 216;
const MAX_SIDEBAR_WIDTH = 420;
const MAX_RENDERED_VALUE_LENGTH = 16_000;
const AUTH_REQUIRED = import.meta.env.VITE_AGENT_DOCK_AUTH_REQUIRED === "true";

function shortId(value: string): string {
  return value.slice(0, 8);
}

function timeLabel(value: string | null): string {
  if (value === null) return "pending";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "unknown"
    : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function displayValue(value: unknown): string {
  let rendered: string;
  if (typeof value === "string") {
    rendered = value;
  } else {
    try {
      rendered = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      rendered = "[value could not be rendered]";
    }
  }
  if (rendered.length <= MAX_RENDERED_VALUE_LENGTH) return rendered;
  return `${rendered.slice(0, MAX_RENDERED_VALUE_LENGTH)}\n… browser preview truncated`;
}

function statusLabel(status: TurnViewStatus): string {
  if (status === "queued") return "queued · durable";
  if (status === "running") return "running · sandbox active";
  if (status === "cancelling") return "cancelling · awaiting teardown";
  if (status === "completed") return "completed · sandbox released";
  if (status === "cancelled") return "cancelled · sandbox released";
  return "failed · inspect event";
}

function StatusMark({ status }: { status: TurnViewStatus }) {
  return (
    <span className={`status-mark status-${status}`}>
      <span aria-hidden="true" className="status-glyph">
        {status === "completed"
          ? "✓"
          : status === "failed"
            ? "!"
            : status === "cancelled"
              ? "×"
              : status === "cancelling"
                ? "◌"
                : status === "running"
                  ? "●"
                  : "·"}
      </span>
      {statusLabel(status)}
    </span>
  );
}

function Sequence({ first, last }: { first: number; last: number | undefined }) {
  return (
    <span className="sequence" title="Durable session event sequence">
      #{String(first)}
      {last !== undefined && last !== first ? `–${String(last)}` : ""}
    </span>
  );
}

function MarkdownText({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: linkChildren, href }) => (
            <a href={href} rel="noreferrer noopener" target="_blank">
              {linkChildren}
            </a>
          ),
          img: ({ alt }) => (
            <span className="remote-image-placeholder">[remote image{alt ? `: ${alt}` : ""}]</span>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ToolItem({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const terminal = item.status !== "running";
  return (
    <details className={`tool-block tool-${item.status}`}>
      <summary>
        <span className="tool-chevron" aria-hidden="true" />
        <span className="tool-name">{item.toolName}</span>
        <span className="tool-state">
          {item.status === "running" ? "running" : item.status === "failed" ? "error" : "done"}
        </span>
        <Sequence first={item.firstSequence} last={item.lastSequence} />
      </summary>
      <div className="tool-detail">
        <div className="detail-label">input</div>
        <pre>{displayValue(item.input)}</pre>
        {terminal && item.output !== undefined ? (
          <>
            <div className="detail-label">output</div>
            <pre>{displayValue(item.output)}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

function ApprovalItem({ item }: { item: Extract<TranscriptItem, { kind: "approval" }> }) {
  const approval = item.approval;
  const description =
    approval.kind === "confirm"
      ? approval.message
      : approval.kind === "select"
        ? `${String(approval.options.length)} options requested`
        : approval.kind === "input"
          ? (approval.placeholder ?? "Text input requested")
          : "Editor input requested";
  return (
    <section className="approval-card" aria-label={`${approval.kind} approval`}>
      <div className="approval-heading">
        <span>approval · {approval.kind}</span>
        <Sequence first={item.firstSequence} last={item.lastSequence} />
      </div>
      <strong>{approval.title}</strong>
      <p>{description}</p>
      <div className="approval-outcome">
        {item.outcome === undefined
          ? "waiting for the approval control-plane endpoint"
          : `resolved · ${item.outcome}`}
      </div>
    </section>
  );
}

function TranscriptItemView({ item }: { item: TranscriptItem }) {
  if (item.kind === "text") {
    return (
      <div className="assistant-text">
        <MarkdownText>{item.text}</MarkdownText>
        <Sequence first={item.firstSequence} last={item.lastSequence} />
      </div>
    );
  }
  if (item.kind === "tool") return <ToolItem item={item} />;
  if (item.kind === "approval") return <ApprovalItem item={item} />;
  return (
    <div className={`notification notification-${item.level}`}>
      <span>{item.level}</span>
      <p>{item.message}</p>
      <Sequence first={item.sequence} last={undefined} />
    </div>
  );
}

function TurnTranscript({ turn }: { turn: TurnView }) {
  return (
    <article className="turn" id={`turn-${turn.turnId}`}>
      <header className="turn-meta">
        <span>turn {shortId(turn.turnId)}</span>
        <span>
          mailbox {turn.mailboxPosition === null ? "pending" : `#${String(turn.mailboxPosition)}`}
        </span>
        <span>{timeLabel(turn.acceptedAt)}</span>
        <StatusMark status={turn.status} />
      </header>
      <section className="user-message" aria-label="User message">
        <div className="message-role">you</div>
        <p>{turn.prompt}</p>
      </section>
      <section className="assistant-message" aria-label="Agent response">
        <div className="message-role">pi · root</div>
        {turn.items.length === 0 ? (
          <div className="pending-line">
            <span className="activity-dot" aria-hidden="true" />
            {turn.status === "queued" ? "waiting for durable dispatcher" : "agent is working"}
          </div>
        ) : (
          turn.items.map((item) => <TranscriptItemView item={item} key={item.key} />)
        )}
        {turn.failure ? (
          <section className="terminal-card terminal-failed">
            <strong>{turn.failure.code}</strong>
            <p>{turn.failure.message}</p>
            <span>{turn.failure.retryable ? "retryable" : "not retryable"}</span>
          </section>
        ) : null}
        {turn.cancellation ? (
          <section className="terminal-card terminal-cancelled">
            <strong>Turn cancelled</strong>
            <p>
              reason: {turn.cancellation.reason} · forced teardown:{" "}
              {turn.cancellation.forced ? "yes" : "no"}
            </p>
          </section>
        ) : null}
        {turn.workspacePatch ? (
          <details className="diff-block" open>
            <summary>
              <span>final workspace diff</span>
              <span>{turn.workspacePatch.truncated ? "truncated" : "complete"}</span>
            </summary>
            <pre>{turn.workspacePatch.patch}</pre>
          </details>
        ) : null}
      </section>
    </article>
  );
}

function EmptyTranscript() {
  return (
    <section className="empty-transcript">
      <div className="empty-kicker">PHASE 1 · ZERO TOKEN DEMO</div>
      <h1>A cloud control plane around Pi, not a chat-page wrapper.</h1>
      <p>
        Submit the prepared task to create a durable session. AgentDock will claim the turn, acquire
        a fenced lease, activate a hardened Docker workspace, run pinned Pi, and replay every
        committed event here.
      </p>
      <div className="boundary-grid">
        <span>PostgreSQL outbox</span>
        <span>resumable SSE</span>
        <span>networkless sandbox</span>
        <span>bounded Git diff</span>
      </div>
    </section>
  );
}

function connectionLabel(phase: string, attempt: number): string {
  if (phase === "live") return "live · durable cursor";
  if (phase === "reconnecting") return `reconnecting · attempt ${String(attempt)}`;
  if (phase === "connecting") return "connecting · replay pending";
  if (phase === "failed") return "stream failed · manual retry";
  return "offline · no session";
}

function apiFailureMessage(error: unknown): string {
  if (error instanceof AgentDockApiError) return `${error.code}: ${error.message}`;
  return "Unexpected browser error; the request was not confirmed.";
}

export default function App() {
  const [apiToken, setApiToken] = useState("");
  const [identity, setIdentity] = useState<TenantIdentityResource | null>(null);
  const [credentialInput, setCredentialInput] = useState("");
  const [credentialChecking, setCredentialChecking] = useState(false);
  const api = useMemo(
    () => new AgentDockApi(globalThis.fetch.bind(globalThis), apiToken || undefined),
    [apiToken],
  );
  const [state, setState] = useState(createInitialSessionView);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [operation, setOperation] = useState<"creating" | "submitting" | "cancelling" | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const lastSequenceRef = useRef(0);
  const currentTurn = activeTurn(state);
  const canMutate = identity?.role !== "viewer";
  const sessionCanQueueTurn =
    state.session === null ||
    state.sessionState === "cold" ||
    state.sessionState === "idle" ||
    state.sessionState === "running" ||
    state.sessionState === "waiting_approval" ||
    state.sessionState === "cancelling";
  const hasSettledTurn = state.turns.length > 0 && currentTurn === undefined;
  const sessionNeedsReset =
    state.session !== null && currentTurn === undefined && !sessionCanQueueTurn;

  const update = (action: Parameters<typeof sessionViewReducer>[1]): void => {
    setState((current) => sessionViewReducer(current, action));
  };

  useEffect(() => {
    const sessionId = state.session?.sessionId;
    if (sessionId === undefined) return;
    const controller = new AbortController();
    void streamSessionEvents({
      sessionId,
      afterSequence: lastSequenceRef.current,
      signal: controller.signal,
      ...(apiToken.length === 0 ? {} : { authorizationToken: apiToken }),
      onEvent(event) {
        lastSequenceRef.current = event.seq;
        update({ type: "stream.event", event });
      },
      onStatus(status) {
        update({ type: "stream.status", status });
      },
    }).catch(() => {
      if (!controller.signal.aborted) {
        update({ type: "api.error", message: "The event stream stopped unexpectedly." });
      }
    });
    return () => controller.abort();
  }, [state.session?.sessionId, reconnectGeneration, apiToken]);

  async function acceptCredential(): Promise<void> {
    const token = credentialInput.trim();
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(token)) {
      update({ type: "api.error", message: "API credential format is invalid." });
      return;
    }
    setCredentialChecking(true);
    update({ type: "api.error.cleared" });
    try {
      const candidateApi = new AgentDockApi(globalThis.fetch.bind(globalThis), token);
      const resolvedIdentity = await candidateApi.getIdentity();
      lastSequenceRef.current = 0;
      setState(createInitialSessionView());
      setIdentity(resolvedIdentity);
      setApiToken(token);
      setCredentialInput("");
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setCredentialChecking(false);
    }
  }

  function forgetCredential(): void {
    lastSequenceRef.current = 0;
    setState(createInitialSessionView());
    setIdentity(null);
    setApiToken("");
    setOperation(null);
  }

  async function createSession() {
    if (!canMutate) return undefined;
    setOperation("creating");
    update({ type: "api.error.cleared" });
    try {
      const project = await api.createProject(`Java repair demo ${new Date().toISOString()}`);
      const session = await api.createSession(project);
      lastSequenceRef.current = 0;
      update({ type: "session.created", project, session });
      setSidebarOpen(false);
      return session;
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
      return undefined;
    } finally {
      setOperation(null);
    }
  }

  async function submitTurn(): Promise<void> {
    const normalizedPrompt = prompt.trim();
    if (normalizedPrompt.length === 0 || !canMutate || !sessionCanQueueTurn || operation !== null) {
      return;
    }
    setOperation("submitting");
    update({ type: "api.error.cleared" });
    try {
      let session = state.session;
      if (session === null) {
        const project = await api.createProject(`Java repair demo ${new Date().toISOString()}`);
        session = await api.createSession(project);
        lastSequenceRef.current = 0;
        update({ type: "session.created", project, session });
      }
      const accepted = await api.acceptTurn(
        session.sessionId,
        normalizedPrompt,
        newIdempotencyKey("turn"),
        "off",
      );
      update({ type: "turn.accepted", accepted, prompt: normalizedPrompt });
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function cancelActiveTurn(): Promise<void> {
    if (
      !canMutate ||
      state.session === null ||
      currentTurn?.status !== "running" ||
      operation !== null
    ) {
      return;
    }
    setOperation("cancelling");
    update({ type: "api.error.cleared" });
    try {
      await api.cancelTurn(
        state.session.sessionId,
        currentTurn.turnId,
        newIdempotencyKey("cancel"),
      );
      update({ type: "turn.cancellation.requested", turnId: currentTurn.turnId });
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  function resizeStart(event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startingX = event.clientX;
    const startingWidth = sidebarWidth;
    const move = (moveEvent: globalThis.PointerEvent): void => {
      setSidebarWidth(
        Math.min(
          MAX_SIDEBAR_WIDTH,
          Math.max(MIN_SIDEBAR_WIDTH, startingWidth + moveEvent.clientX - startingX),
        ),
      );
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarWidth((width) =>
      Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, width + (event.key === "ArrowRight" ? 12 : -12)),
      ),
    );
  }

  if (AUTH_REQUIRED && (apiToken.length === 0 || identity === null)) {
    return (
      <main className="credential-gate">
        <form
          className="credential-card"
          onSubmit={(event) => {
            event.preventDefault();
            void acceptCredential();
          }}
        >
          <div className="brand-mark" aria-hidden="true">
            AD
          </div>
          <span className="empty-kicker">SELF-HOSTED ACCESS</span>
          <h1>Connect to AgentDock</h1>
          <p>Enter a tenant API token. It is verified first and kept only in browser memory.</p>
          <label htmlFor="api-credential">API token</label>
          <input
            autoComplete="off"
            id="api-credential"
            onChange={(event) => setCredentialInput(event.target.value)}
            spellCheck={false}
            type="password"
            value={credentialInput}
          />
          {state.apiError ? <div className="credential-error">{state.apiError}</div> : null}
          <button disabled={credentialChecking} type="submit">
            {credentialChecking ? "verifying…" : "continue"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div
      className="app-shell"
      style={{ "--sidebar-width": `${String(sidebarWidth)}px` } as CSSProperties}
    >
      <button
        aria-label="Close session sidebar"
        className={`sidebar-backdrop ${sidebarOpen ? "visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
        type="button"
      />
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <header className="brand">
          <div className="brand-mark" aria-hidden="true">
            AD
          </div>
          <div>
            <strong>AgentDock</strong>
            <span>cloud Pi runtime</span>
          </div>
        </header>
        <div className="sidebar-actions">
          <button
            disabled={!canMutate || currentTurn !== undefined || operation !== null}
            onClick={() => void createSession()}
            type="button"
          >
            <span aria-hidden="true">＋</span> new demo session
          </button>
        </div>
        <div className="tree-heading">
          <span>SESSION TREE</span>
          <span>{state.turns.length}</span>
        </div>
        <nav className="session-tree" aria-label="Session tree">
          {state.session === null ? (
            <div className="tree-empty">No durable session yet.</div>
          ) : (
            <div className="tree-root">
              <div className="tree-session active">
                <span className="tree-caret">⌄</span>
                <span className="role-dot root-dot" />
                <span className="tree-label">root</span>
                <span className="tree-id">{shortId(state.session.sessionId)}</span>
              </div>
              <div className="tree-children">
                {state.turns.length === 0 ? (
                  <div className="tree-placeholder">ready for first turn</div>
                ) : (
                  state.turns.map((turn, index) => (
                    <a
                      className="tree-turn"
                      href={`#turn-${turn.turnId}`}
                      key={turn.turnId}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <span className={`tree-status tree-status-${turn.status}`} />
                      <span>turn {String(index + 1)}</span>
                      <span className="tree-id">{shortId(turn.turnId)}</span>
                    </a>
                  ))
                )}
              </div>
            </div>
          )}
        </nav>
        <footer className="sidebar-footer">
          {identity ? (
            <div className="tenant-identity">
              <span>tenant</span>
              <strong>{identity.tenantSlug}</strong>
              <small>
                {identity.displayName} · {identity.role}
              </small>
            </div>
          ) : null}
          <div>
            <span>model</span>
            <strong>embedded fake · fixed</strong>
          </div>
          <div>
            <span>runtime</span>
            <strong>Pi 0.80.10 · bash/edit</strong>
          </div>
          <div>
            <span>sandbox</span>
            <strong>ephemeral · network none</strong>
          </div>
        </footer>
      </aside>
      <div
        aria-label="Resize session sidebar"
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        className="sidebar-resizer"
        onKeyDown={resizeWithKeyboard}
        onPointerDown={resizeStart}
        role="separator"
        tabIndex={0}
      />
      <main className="main-pane">
        <header className="topbar">
          <button
            aria-label="Open session sidebar"
            className="mobile-menu"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            ☰
          </button>
          <div className="topbar-title">
            <strong>{state.project?.name ?? "Java repair session"}</strong>
            <span>
              {state.session ? `session ${shortId(state.session.sessionId)}` : "not created"}
            </span>
          </div>
          <div className="topbar-status">
            <span className={`connection-dot connection-${state.connection.phase}`} />
            <span>{connectionLabel(state.connection.phase, state.connection.attempt)}</span>
            <span className="cursor-label">seq {String(state.lastSequence)}</span>
            <button
              disabled={state.session === null}
              onClick={() => setReconnectGeneration((value) => value + 1)}
              title="Reconnect using the last durable event sequence"
              type="button"
            >
              reconnect
            </button>
            {AUTH_REQUIRED ? (
              <button onClick={forgetCredential} title="Forget API token" type="button">
                logout
              </button>
            ) : null}
          </div>
        </header>
        {state.apiError ? (
          <div className="error-banner" role="alert">
            <span>request not confirmed</span>
            <p>{state.apiError}</p>
            <button onClick={() => update({ type: "api.error.cleared" })} type="button">
              dismiss
            </button>
          </div>
        ) : null}
        <div className="transcript-scroll">
          <div className="transcript">
            {state.turns.length === 0 ? (
              <EmptyTranscript />
            ) : (
              state.turns.map((turn) => <TurnTranscript key={turn.turnId} turn={turn} />)
            )}
          </div>
        </div>
        <footer className="composer-shell">
          <div className="composer">
            <textarea
              aria-label="Turn prompt"
              disabled={!canMutate || !sessionCanQueueTurn || operation !== null}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitTurn();
                }
              }}
              rows={2}
              value={prompt}
            />
            <div className="composer-controls">
              <div className="composer-hints">
                <span>sample/java-repair</span>
                <span>
                  {sessionNeedsReset
                    ? "new session required"
                    : currentTurn !== undefined
                      ? "follow-up queues · never steers"
                      : hasSettledTurn
                        ? "cold restore ready"
                        : "thinking off"}
                </span>
                <span>⌘/Ctrl + Enter</span>
              </div>
              <div className="composer-actions">
                {currentTurn?.status === "running" ? (
                  <button
                    className="cancel-button"
                    disabled={!canMutate || operation !== null}
                    onClick={() => void cancelActiveTurn()}
                    type="button"
                  >
                    {operation === "cancelling" ? "accepting cancel…" : "cancel turn"}
                  </button>
                ) : null}
                <button
                  className="send-button"
                  disabled={
                    !canMutate || !sessionCanQueueTurn || operation !== null || prompt.trim() === ""
                  }
                  onClick={() => void submitTurn()}
                  type="button"
                >
                  {!canMutate
                    ? "viewer · read only"
                    : operation === "submitting" || operation === "creating"
                      ? "accepting…"
                      : sessionNeedsReset
                        ? "new session required"
                        : currentTurn !== undefined
                          ? "queue follow-up"
                          : hasSettledTurn
                            ? "send follow-up"
                            : "run repair"}
                </button>
              </div>
            </div>
          </div>
          <div className="runtime-strip">
            <span>session: {state.sessionState}</span>
            <span>turn: {currentTurn?.status ?? "settled"}</span>
            <span>durable through: #{String(state.lastSequence)}</span>
            <span>browser never receives provider credentials</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
