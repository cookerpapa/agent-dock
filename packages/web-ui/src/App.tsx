import {
  useCallback,
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
import type {
  ConversationSummaryResource,
  DeepSeekModelId,
  GitHubInstallationResource,
  ModelConfigurationResource,
  TenantIdentityResource,
  WorkspaceSourceRequest,
} from "@agent-dock/protocol";
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
import { WorkspaceInspector } from "./WorkspaceInspector.tsx";

const DEFAULT_PROMPT = "Run the tests, repair the Java bug, and verify the result.";
const MIN_SIDEBAR_WIDTH = 216;
const MAX_SIDEBAR_WIDTH = 420;
const MAX_RENDERED_VALUE_LENGTH = 16_000;
const AUTH_REQUIRED = import.meta.env.VITE_AGENT_DOCK_AUTH_REQUIRED === "true";

function shortId(value: string): string {
  return value.slice(0, 8);
}

function workspaceSourceLabel(source: WorkspaceSourceRequest | undefined): string {
  if (source === undefined || source.kind === "sample_java") return "sample/java-repair";
  if (source.kind === "empty") return "empty workspace";
  if (source.kind === "github_app") {
    return `github-app:${String(source.repositoryId)}@${source.commitSha.slice(0, 8)}`;
  }
  return `${source.repository}@${source.commitSha.slice(0, 8)}`;
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

function EmptyTranscript({ realModel }: { realModel: boolean }) {
  return (
    <section className="empty-transcript">
      <div className="empty-kicker">
        {realModel ? "REAL MODEL · BROKERED EGRESS" : "PHASE 1 · ZERO TOKEN DEMO"}
      </div>
      <h1>A cloud control plane around Pi, not a chat-page wrapper.</h1>
      <p>
        Submit the prepared task to create a durable session. AgentDock will claim the turn, acquire
        a fenced lease, activate a hardened Kubernetes gVisor workspace, run pinned Pi, and replay
        every committed event here.
      </p>
      <div className="boundary-grid">
        <span>PostgreSQL outbox</span>
        <span>resumable SSE</span>
        <span>{realModel ? "capability-only model egress" : "networkless sandbox"}</span>
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
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [apiToken, setApiToken] = useState("");
  const [identity, setIdentity] = useState<TenantIdentityResource | null>(null);
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfigurationResource | null>(
    null,
  );
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [modelCredentialInput, setModelCredentialInput] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<DeepSeekModelId>("deepseek-v4-flash");
  const [modelConfigurationSaving, setModelConfigurationSaving] = useState(false);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSourceKind, setWorkspaceSourceKind] =
    useState<WorkspaceSourceRequest["kind"]>("sample_java");
  const [workspaceRepository, setWorkspaceRepository] = useState("");
  const [workspaceCommitSha, setWorkspaceCommitSha] = useState("");
  const [workspaceInstallationId, setWorkspaceInstallationId] = useState("");
  const [workspaceRepositoryId, setWorkspaceRepositoryId] = useState("");
  const [githubInstallation, setGitHubInstallation] = useState<GitHubInstallationResource | null>(
    null,
  );
  const [githubInstallationLoading, setGitHubInstallationLoading] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorRefreshSignal, setInspectorRefreshSignal] = useState(0);
  const [credentialInput, setCredentialInput] = useState("");
  const [credentialChecking, setCredentialChecking] = useState(false);
  const [registrationSlug, setRegistrationSlug] = useState("");
  const [registrationDisplayName, setRegistrationDisplayName] = useState("");
  const [newlyIssuedToken, setNewlyIssuedToken] = useState<string | null>(null);
  const api = useMemo(
    () => new AgentDockApi(globalThis.fetch.bind(globalThis), apiToken || undefined),
    [apiToken],
  );
  const [state, setState] = useState(createInitialSessionView);
  const [conversations, setConversations] = useState<readonly ConversationSummaryResource[]>([]);
  const [conversationListTruncated, setConversationListTruncated] = useState(false);
  const [conversationLoading, setConversationLoading] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [operation, setOperation] = useState<"creating" | "submitting" | "cancelling" | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const lastSequenceRef = useRef(0);
  const currentTurn = activeTurn(state);
  const canMutate = identity?.role !== "viewer";
  const canConfigureModel = identity?.role === "owner";
  const usesRealModel = modelConfiguration?.mode === "real";
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

  const reportInspectorError = useCallback((message: string): void => {
    setState((current) => sessionViewReducer(current, { type: "api.error", message }));
  }, []);

  function clearTenantView(): void {
    lastSequenceRef.current = 0;
    setState(createInitialSessionView());
    setConversations([]);
    setConversationListTruncated(false);
    setConversationLoading(null);
    setOperation(null);
    setReconnectGeneration(0);
    setModelConfiguration(null);
    setModelPanelOpen(false);
    setModelCredentialInput("");
    setModelConfigurationSaving(false);
    setWorkspacePanelOpen(false);
    setWorkspaceName("");
    setWorkspaceSourceKind("sample_java");
    setWorkspaceRepository("");
    setWorkspaceCommitSha("");
    setWorkspaceInstallationId("");
    setWorkspaceRepositoryId("");
    setGitHubInstallation(null);
    setGitHubInstallationLoading(false);
    setInspectorOpen(false);
    setInspectorRefreshSignal(0);
  }

  async function refreshConversations(candidateApi: AgentDockApi = api): Promise<void> {
    const listed = await candidateApi.listConversations();
    setConversations(listed.conversations);
    setConversationListTruncated(listed.truncated);
  }

  useEffect(() => {
    if (identity === null || apiToken.length === 0) {
      setConversations([]);
      setConversationListTruncated(false);
      return;
    }
    let cancelled = false;
    void api
      .listConversations()
      .then((listed) => {
        if (cancelled) return;
        setConversations(listed.conversations);
        setConversationListTruncated(listed.truncated);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        update({ type: "api.error", message: apiFailureMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, apiToken, identity?.tenantId]);

  useEffect(() => {
    if (identity === null || (AUTH_REQUIRED && apiToken.length === 0)) {
      setModelConfiguration(null);
      return;
    }
    let cancelled = false;
    void api
      .getModelConfiguration()
      .then((configuration) => {
        if (cancelled) return;
        setModelConfiguration(configuration);
        if (configuration.mode === "real") setSelectedModelId(configuration.modelId);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        update({ type: "api.error", message: apiFailureMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, apiToken, identity?.tenantId]);

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
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled"
        ) {
          setInspectorRefreshSignal((value) => value + 1);
          void refreshConversations().catch(() => undefined);
        }
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
      clearTenantView();
      setIdentity(resolvedIdentity);
      setApiToken(token);
      setCredentialInput("");
      setNewlyIssuedToken(null);
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setCredentialChecking(false);
    }
  }

  async function registerTenant(): Promise<void> {
    if (registrationSlug.trim().length === 0 || registrationDisplayName.trim().length === 0) {
      update({ type: "api.error", message: "Tenant slug and owner display name are required." });
      return;
    }
    setCredentialChecking(true);
    update({ type: "api.error.cleared" });
    try {
      const anonymousApi = new AgentDockApi(globalThis.fetch.bind(globalThis));
      const registration = await anonymousApi.registerTenant(
        registrationSlug,
        registrationDisplayName,
      );
      const candidateApi = new AgentDockApi(
        globalThis.fetch.bind(globalThis),
        registration.apiToken,
      );
      const resolvedIdentity = await candidateApi.getIdentity();
      clearTenantView();
      setIdentity(resolvedIdentity);
      setApiToken(registration.apiToken);
      setNewlyIssuedToken(registration.apiToken);
      setRegistrationSlug("");
      setRegistrationDisplayName("");
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setCredentialChecking(false);
    }
  }

  function forgetCredential(): void {
    clearTenantView();
    setIdentity(null);
    setApiToken("");
    setNewlyIssuedToken(null);
    setAuthMode("login");
  }

  async function replaceModelConfiguration(): Promise<void> {
    if (!canConfigureModel || modelConfigurationSaving) return;
    const providerKey = modelCredentialInput.trim();
    if (!/^[A-Za-z0-9._-]{16,512}$/.test(providerKey)) {
      update({ type: "api.error", message: "DeepSeek API key format is invalid." });
      return;
    }
    setModelConfigurationSaving(true);
    update({ type: "api.error.cleared" });
    try {
      const configured = await api.replaceModelConfiguration(selectedModelId, providerKey);
      setModelConfiguration(configured);
      setModelCredentialInput("");
      setModelPanelOpen(false);
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setModelConfigurationSaving(false);
    }
  }

  async function openConversation(conversation: ConversationSummaryResource): Promise<void> {
    if (conversationLoading !== null || operation !== null) return;
    setConversationLoading(conversation.sessionId);
    update({ type: "api.error.cleared" });
    try {
      const detail = await api.getConversation(conversation.sessionId);
      lastSequenceRef.current = detail.replayAfterSequence;
      update({ type: "conversation.loaded", conversation: detail });
      setSidebarOpen(false);
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setConversationLoading(null);
    }
  }

  async function openConversationById(sessionId: string): Promise<void> {
    setConversationLoading(sessionId);
    update({ type: "api.error.cleared" });
    try {
      const detail = await api.getConversation(sessionId);
      lastSequenceRef.current = detail.replayAfterSequence;
      update({ type: "conversation.loaded", conversation: detail });
      setInspectorRefreshSignal((value) => value + 1);
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setConversationLoading(null);
    }
  }

  async function provisionSession(name: string, source: WorkspaceSourceRequest) {
    if (!canMutate) return undefined;
    setOperation("creating");
    update({ type: "api.error.cleared" });
    try {
      const project = await api.createProject(name, source);
      const session = await api.createSession(project);
      lastSequenceRef.current = 0;
      update({ type: "session.created", project, session });
      await refreshConversations();
      setSidebarOpen(false);
      return session;
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
      return undefined;
    } finally {
      setOperation(null);
    }
  }

  async function createWorkspaceSession(): Promise<void> {
    const name = workspaceName.trim();
    if (name.length === 0) {
      update({ type: "api.error", message: "Workspace name is required." });
      return;
    }
    const source: WorkspaceSourceRequest =
      workspaceSourceKind === "empty"
        ? { kind: "empty" }
        : workspaceSourceKind === "sample_java"
          ? { kind: "sample_java" }
          : workspaceSourceKind === "github_public"
            ? {
                kind: "github_public",
                repository: workspaceRepository.trim(),
                commitSha: workspaceCommitSha.trim(),
              }
            : {
                kind: "github_app",
                installationId: Number(workspaceInstallationId),
                repositoryId: Number(workspaceRepositoryId),
                commitSha: workspaceCommitSha.trim(),
              };
    const session = await provisionSession(name, source);
    if (session !== undefined) {
      setWorkspacePanelOpen(false);
      setWorkspaceName("");
      setWorkspaceRepository("");
      setWorkspaceCommitSha("");
      setWorkspaceInstallationId("");
      setWorkspaceRepositoryId("");
      setGitHubInstallation(null);
    }
  }

  async function loadGitHubInstallation(): Promise<void> {
    const installationId = Number(workspaceInstallationId);
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      update({ type: "api.error", message: "GitHub App installation ID must be positive." });
      return;
    }
    setGitHubInstallationLoading(true);
    update({ type: "api.error.cleared" });
    try {
      const installation =
        identity?.role === "owner"
          ? await api.registerGitHubInstallation(installationId)
          : await api.getGitHubInstallation(installationId);
      setGitHubInstallation(installation);
      setWorkspaceRepositoryId(
        String(
          installation.repositories.find((repository) => repository.enabled)?.repositoryId ?? "",
        ),
      );
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setGitHubInstallationLoading(false);
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
        const project = await api.createProject(`Java repair demo ${new Date().toISOString()}`, {
          kind: "sample_java",
        });
        session = await api.createSession(project);
        lastSequenceRef.current = 0;
        update({ type: "session.created", project, session });
        await refreshConversations();
      }
      const accepted = await api.acceptTurn(
        session.sessionId,
        normalizedPrompt,
        newIdempotencyKey("turn"),
        "off",
      );
      update({ type: "turn.accepted", accepted, prompt: normalizedPrompt });
      setInspectorRefreshSignal((value) => value + 1);
      await refreshConversations();
    } catch (error: unknown) {
      update({ type: "api.error", message: apiFailureMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function retryRun(runId: string): Promise<void> {
    if (!canMutate || state.session === null || operation !== null || !sessionCanQueueTurn) return;
    const run = await api.getRun(runId);
    const original = state.turns.find((turn) => turn.turnId === run.turnId);
    if (original === undefined) {
      throw new AgentDockApiError(
        409,
        "retry_prompt_unavailable",
        "Original Run prompt is not loaded",
      );
    }
    setOperation("submitting");
    update({ type: "api.error.cleared" });
    try {
      const accepted = await api.acceptTurn(
        state.session.sessionId,
        original.prompt,
        newIdempotencyKey("retry"),
        "off",
      );
      update({ type: "turn.accepted", accepted, prompt: original.prompt });
      setPrompt(original.prompt);
      setInspectorRefreshSignal((value) => value + 1);
      await refreshConversations();
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
            void (authMode === "login" ? acceptCredential() : registerTenant());
          }}
        >
          <div className="brand-mark" aria-hidden="true">
            AD
          </div>
          <span className="empty-kicker">SELF-HOSTED MULTI-TENANT ACCESS</span>
          <div className="credential-tabs" role="tablist" aria-label="Authentication mode">
            <button
              aria-selected={authMode === "login"}
              className={authMode === "login" ? "active" : ""}
              onClick={() => {
                setAuthMode("login");
                update({ type: "api.error.cleared" });
              }}
              role="tab"
              type="button"
            >
              use token
            </button>
            <button
              aria-selected={authMode === "register"}
              className={authMode === "register" ? "active" : ""}
              onClick={() => {
                setAuthMode("register");
                update({ type: "api.error.cleared" });
              }}
              role="tab"
              type="button"
            >
              create tenant
            </button>
          </div>
          <h1>{authMode === "login" ? "Connect to AgentDock" : "Create an isolated tenant"}</h1>
          {authMode === "login" ? (
            <>
              <p>Enter a tenant API token. It is verified and kept only in browser memory.</p>
              <label htmlFor="api-credential">API token</label>
              <input
                autoComplete="off"
                id="api-credential"
                onChange={(event) => setCredentialInput(event.target.value)}
                spellCheck={false}
                type="password"
                value={credentialInput}
              />
            </>
          ) : (
            <>
              <p>
                Create a local tenant with independent conversations, quotas, events, and
                checkpoints. Registration may be disabled by the operator.
              </p>
              <label htmlFor="registration-slug">Tenant slug</label>
              <input
                autoComplete="organization"
                id="registration-slug"
                onChange={(event) => setRegistrationSlug(event.target.value)}
                placeholder="team-alpha"
                spellCheck={false}
                value={registrationSlug}
              />
              <label htmlFor="registration-display-name">Owner display name</label>
              <input
                autoComplete="name"
                id="registration-display-name"
                onChange={(event) => setRegistrationDisplayName(event.target.value)}
                placeholder="Alpha Owner"
                value={registrationDisplayName}
              />
            </>
          )}
          {state.apiError ? <div className="credential-error">{state.apiError}</div> : null}
          <button disabled={credentialChecking} type="submit">
            {credentialChecking
              ? authMode === "login"
                ? "verifying…"
                : "creating…"
              : authMode === "login"
                ? "continue"
                : "create tenant and continue"}
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
            onClick={() => {
              setWorkspaceName(`Workspace ${new Date().toISOString()}`);
              setWorkspacePanelOpen(true);
              setSidebarOpen(false);
            }}
            type="button"
          >
            <span aria-hidden="true">＋</span> new workspace
          </button>
        </div>
        <div className="sidebar-scroll">
          <div className="tree-heading">
            <span>MY CONVERSATIONS</span>
            <span>{conversations.length}</span>
          </div>
          <nav className="conversation-list" aria-label="Tenant conversations">
            {conversations.length === 0 ? (
              <div className="tree-empty">No conversations in this tenant.</div>
            ) : (
              conversations.map((conversation) => (
                <button
                  className={
                    state.session?.sessionId === conversation.sessionId
                      ? "conversation-item active"
                      : "conversation-item"
                  }
                  disabled={conversationLoading !== null || operation !== null}
                  key={conversation.sessionId}
                  onClick={() => void openConversation(conversation)}
                  type="button"
                >
                  <span className="conversation-name">{conversation.projectName}</span>
                  <span className="conversation-meta">
                    {conversation.state} · {String(conversation.turnCount)} turns ·{" "}
                    {shortId(conversation.sessionId)}
                  </span>
                </button>
              ))
            )}
            {conversationListTruncated ? (
              <div className="tree-placeholder">Showing the newest 100 conversations.</div>
            ) : null}
          </nav>
          <div className="tree-heading">
            <span>CURRENT SESSION</span>
            <span>{state.turns.length}</span>
          </div>
          <nav className="session-tree" aria-label="Session tree">
            {state.session === null ? (
              <div className="tree-empty">Select or create a durable session.</div>
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
        </div>
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
            <strong>
              {modelConfiguration?.mode === "real"
                ? `${modelConfiguration.provider} · ${modelConfiguration.modelId}`
                : "embedded fake · fixed"}
            </strong>
          </div>
          <div>
            <span>runtime</span>
            <strong>Pi 0.80.10 · bash/edit</strong>
          </div>
          <div>
            <span>sandbox</span>
            <strong>
              {usesRealModel ? "ephemeral · broker-only network" : "ephemeral · network none"}
            </strong>
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
            {canConfigureModel ? (
              <button
                onClick={() => setModelPanelOpen((open) => !open)}
                title="Configure tenant model credential"
                type="button"
              >
                model
              </button>
            ) : null}
            <button
              aria-pressed={inspectorOpen}
              disabled={state.session === null}
              onClick={() => setInspectorOpen((open) => !open)}
              title="Inspect Workspace versions, Runs, tests, usage, and audit"
              type="button"
            >
              inspect
            </button>
            {AUTH_REQUIRED ? (
              <button onClick={forgetCredential} title="Forget API token" type="button">
                logout
              </button>
            ) : null}
          </div>
        </header>
        {newlyIssuedToken ? (
          <section className="credential-notice" aria-label="New owner API token">
            <div>
              <strong>Save this owner token now.</strong>
              <span>It is shown once and is not recoverable from the database.</span>
            </div>
            <input aria-label="New owner API token" readOnly value={newlyIssuedToken} />
            <button
              onClick={() => void globalThis.navigator.clipboard?.writeText(newlyIssuedToken)}
              type="button"
            >
              copy
            </button>
            <button onClick={() => setNewlyIssuedToken(null)} type="button">
              dismiss
            </button>
          </section>
        ) : null}
        {modelPanelOpen && canConfigureModel ? (
          <form
            className="model-configuration-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void replaceModelConfiguration();
            }}
          >
            <div>
              <strong>Tenant model runtime</strong>
              <span>
                The key is encrypted at rest. Pi receives only a short-lived, turn-bound gateway
                capability.
              </span>
            </div>
            <label htmlFor="model-id">model</label>
            <select
              disabled={modelConfigurationSaving}
              id="model-id"
              onChange={(event) => setSelectedModelId(event.target.value as DeepSeekModelId)}
              value={selectedModelId}
            >
              <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
              <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
            </select>
            <label htmlFor="model-api-key">API key</label>
            <input
              autoComplete="off"
              disabled={modelConfigurationSaving}
              id="model-api-key"
              onChange={(event) => setModelCredentialInput(event.target.value)}
              placeholder={usesRealModel ? "enter key to rotate" : "sk-…"}
              spellCheck={false}
              type="password"
              value={modelCredentialInput}
            />
            <button disabled={modelConfigurationSaving || modelCredentialInput.trim() === ""}>
              {modelConfigurationSaving
                ? "encrypting…"
                : usesRealModel
                  ? "rotate / update"
                  : "enable real Pi"}
            </button>
            <button
              disabled={modelConfigurationSaving}
              onClick={() => {
                setModelCredentialInput("");
                setModelPanelOpen(false);
              }}
              type="button"
            >
              cancel
            </button>
          </form>
        ) : null}
        {workspacePanelOpen && canMutate ? (
          <form
            className="workspace-configuration-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void createWorkspaceSession();
            }}
          >
            <div className="workspace-panel-heading">
              <strong>Create an isolated workspace</strong>
              <span>
                Import the built-in sample, a public exact commit, or a tenant-scoped GitHub App
                repository. Every source is pinned to immutable input.
              </span>
            </div>
            <label htmlFor="workspace-name">name</label>
            <input
              disabled={operation !== null}
              id="workspace-name"
              maxLength={256}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Repository task"
              value={workspaceName}
            />
            <label htmlFor="workspace-source">source</label>
            <select
              disabled={operation !== null}
              id="workspace-source"
              onChange={(event) =>
                setWorkspaceSourceKind(event.target.value as WorkspaceSourceRequest["kind"])
              }
              value={workspaceSourceKind}
            >
              <option value="sample_java">Built-in Java repair sample</option>
              <option value="github_public">Public GitHub exact commit</option>
              <option value="github_app">GitHub App repository</option>
            </select>
            {workspaceSourceKind === "github_public" ? (
              <>
                <label htmlFor="workspace-repository">repository</label>
                <input
                  autoComplete="off"
                  disabled={operation !== null}
                  id="workspace-repository"
                  onChange={(event) => setWorkspaceRepository(event.target.value)}
                  placeholder="owner/repository"
                  spellCheck={false}
                  value={workspaceRepository}
                />
                <label htmlFor="workspace-commit">commit SHA</label>
                <input
                  autoComplete="off"
                  disabled={operation !== null}
                  id="workspace-commit"
                  maxLength={40}
                  minLength={40}
                  onChange={(event) => setWorkspaceCommitSha(event.target.value)}
                  pattern="[0-9a-f]{40}"
                  placeholder="40 lowercase hexadecimal characters"
                  spellCheck={false}
                  value={workspaceCommitSha}
                />
              </>
            ) : null}
            {workspaceSourceKind === "github_app" ? (
              <div className="github-installation-picker">
                <label htmlFor="workspace-installation">installation ID</label>
                <input
                  autoComplete="off"
                  disabled={operation !== null || githubInstallationLoading}
                  id="workspace-installation"
                  inputMode="numeric"
                  min="1"
                  onChange={(event) => {
                    setWorkspaceInstallationId(event.target.value);
                    setGitHubInstallation(null);
                    setWorkspaceRepositoryId("");
                  }}
                  placeholder="GitHub App installation ID"
                  type="number"
                  value={workspaceInstallationId}
                />
                <button
                  disabled={
                    operation !== null ||
                    githubInstallationLoading ||
                    workspaceInstallationId.trim() === ""
                  }
                  onClick={() => void loadGitHubInstallation()}
                  type="button"
                >
                  {githubInstallationLoading ? "syncing…" : "sync installation"}
                </button>
                <label htmlFor="workspace-private-repository">repository</label>
                <select
                  disabled={operation !== null || githubInstallation === null}
                  id="workspace-private-repository"
                  onChange={(event) => setWorkspaceRepositoryId(event.target.value)}
                  value={workspaceRepositoryId}
                >
                  <option value="">select enabled repository</option>
                  {githubInstallation?.repositories
                    .filter((repository) => repository.enabled)
                    .map((repository) => (
                      <option key={repository.repositoryId} value={repository.repositoryId}>
                        {repository.fullName} {repository.private ? "· private" : "· public"}
                      </option>
                    ))}
                </select>
                <label htmlFor="workspace-private-commit">commit SHA</label>
                <input
                  autoComplete="off"
                  disabled={operation !== null}
                  id="workspace-private-commit"
                  maxLength={40}
                  minLength={40}
                  onChange={(event) => setWorkspaceCommitSha(event.target.value)}
                  pattern="[0-9a-f]{40}"
                  placeholder="exact 40-character commit SHA"
                  spellCheck={false}
                  value={workspaceCommitSha}
                />
              </div>
            ) : null}
            <div className="workspace-panel-actions">
              <button
                disabled={
                  operation !== null ||
                  workspaceName.trim() === "" ||
                  (workspaceSourceKind === "github_public" &&
                    (workspaceRepository.trim() === "" || workspaceCommitSha.trim() === "")) ||
                  (workspaceSourceKind === "github_app" &&
                    (workspaceInstallationId.trim() === "" ||
                      workspaceRepositoryId.trim() === "" ||
                      workspaceCommitSha.trim() === ""))
                }
                type="submit"
              >
                {operation === "creating" ? "creating…" : "create session"}
              </button>
              <button
                disabled={operation !== null}
                onClick={() => setWorkspacePanelOpen(false)}
                type="button"
              >
                cancel
              </button>
            </div>
          </form>
        ) : null}
        {state.historyTruncated ? (
          <div className="history-notice">
            This conversation is showing its newest 200 prompt turns and matching durable event
            suffix.
          </div>
        ) : null}
        {state.apiError ? (
          <div className="error-banner" role="alert">
            <span>request not confirmed</span>
            <p>{state.apiError}</p>
            <button onClick={() => update({ type: "api.error.cleared" })} type="button">
              dismiss
            </button>
          </div>
        ) : null}
        <div className={`workspace-stage ${inspectorOpen ? "inspector-visible" : ""}`}>
          <div className="transcript-scroll">
            <div className="transcript">
              {state.turns.length === 0 ? (
                <EmptyTranscript realModel={usesRealModel} />
              ) : (
                state.turns.map((turn) => <TurnTranscript key={turn.turnId} turn={turn} />)
              )}
            </div>
          </div>
          {inspectorOpen ? (
            <WorkspaceInspector
              api={api}
              busy={currentTurn !== undefined || operation !== null}
              onClose={() => setInspectorOpen(false)}
              onError={reportInspectorError}
              onForked={openConversationById}
              onRetry={retryRun}
              onSessionChanged={refreshConversations}
              refreshSignal={inspectorRefreshSignal}
              role={identity?.role ?? null}
              projectId={state.project?.projectId ?? null}
              sessionId={state.session?.sessionId ?? null}
              source={state.project?.source ?? null}
            />
          ) : null}
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
                <span>source: {workspaceSourceLabel(state.project?.source)}</span>
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
            <span>Pi receives only a turn-bound gateway capability</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
