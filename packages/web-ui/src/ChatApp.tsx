import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { parse as parsePartialJson } from "partial-json";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ConversationSummaryResource,
  CubeProxyConfigurationResource,
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
} from "./session-view.ts";
import { streamSessionEvents } from "./sse.ts";
import { WorkspaceInspector } from "./WorkspaceInspector.tsx";
import { parseRepositorySetManifest, REPOSITORY_SET_EXAMPLE } from "./repository-set.ts";

type SourceHighlightModule = typeof import("./source-highlight.ts");
type SourceHighlightResult = ReturnType<SourceHighlightModule["highlightSource"]>;

let loadedSourceHighlighter: SourceHighlightModule | null = null;
let sourceHighlighterPromise: Promise<SourceHighlightModule> | null = null;

function useSourceHighlight(text: string, path: string | null): SourceHighlightResult {
  const [ready, setReady] = useState(loadedSourceHighlighter !== null);
  useEffect(() => {
    if (path === null || ready) return;
    sourceHighlighterPromise ??= import("./source-highlight.ts");
    let active = true;
    void sourceHighlighterPromise.then((module) => {
      loadedSourceHighlighter = module;
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [path, ready]);
  return ready && loadedSourceHighlighter !== null
    ? loadedSourceHighlighter.highlightSource(text, path)
    : null;
}

type AuthPhase = "checking" | "anonymous" | "authenticated";
type AuthMode = "login" | "register";

const EXAMPLE_PROMPTS = [
  "帮我分析这个项目，并说明它的核心架构",
  "实现一个 REST API，并补充单元测试",
  "检查当前代码中的 bug，修复后运行测试",
] as const;

function shortId(value: string): string {
  return value.slice(0, 8);
}

function safeDisplay(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (rendered === undefined) return "";
  return rendered.length > 12_000 ? `${rendered.slice(0, 12_000)}\n…输出已截断` : rendered;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  const output = objectValue(value);
  if (output === null || !Array.isArray(output.content)) return safeDisplay(value);
  const content = output.content
    .map((part) => {
      const candidate = objectValue(part);
      return candidate?.type === "text" ? stringValue(candidate.text) : null;
    })
    .filter((part): part is string => part !== null)
    .join("\n");
  return content.length > 0 ? content : safeDisplay(value);
}

function durationLabel(startedAt: string, completedAt: string | undefined): string | null {
  if (completedAt === undefined) return null;
  const milliseconds = new Date(completedAt).valueOf() - new Date(startedAt).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${String(minutes)}m ${((milliseconds % 60_000) / 1_000).toFixed(1)}s`;
}

function ExpandableToolText({
  text,
  direction,
  className,
  sourcePath = null,
  streaming = false,
}: {
  text: string;
  direction: "head" | "tail";
  className: string;
  sourcePath?: string | null;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const normalized = text.replace(/\n+$/, "");
  const lines = normalized.split("\n");
  const maximumLines = direction === "head" ? 16 : 20;
  const omitted = Math.max(0, lines.length - maximumLines);
  const preview =
    omitted === 0
      ? normalized
      : direction === "head"
        ? lines.slice(0, maximumLines).join("\n")
        : lines.slice(-maximumLines).join("\n");
  const visible = expanded ? normalized : preview;
  const highlighted = useSourceHighlight(visible, sourcePath);
  return (
    <div className="product-tool-text">
      {omitted > 0 && !expanded && direction === "tail" ? (
        <button type="button" onClick={() => setExpanded(true)}>
          … {String(omitted)} earlier lines · 展开完整输出
        </button>
      ) : null}
      <pre className={className}>
        {highlighted === null ? (
          <code>{visible}</code>
        ) : (
          <code
            className={`hljs language-${highlighted.language}`}
            dangerouslySetInnerHTML={{ __html: highlighted.html }}
          />
        )}
        {streaming ? <span aria-hidden="true" className="product-tool-stream-cursor" /> : null}
      </pre>
      {omitted > 0 && direction === "head" && !expanded ? (
        <button type="button" onClick={() => setExpanded(true)}>
          … {String(omitted)} more lines · 展开
        </button>
      ) : null}
      {omitted > 0 && expanded ? (
        <button type="button" onClick={() => setExpanded(false)}>
          收起
        </button>
      ) : null}
    </div>
  );
}

function displayedToolInput(item: Extract<TranscriptItem, { kind: "tool" }>): unknown {
  if (item.status !== "preparing" || item.inputJson === undefined) return item.input;
  try {
    return parsePartialJson(item.inputJson);
  } catch {
    return item.input;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentDockApiError) return error.message;
  return "请求没有完成，请稍后重试。";
}

function conversationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const title = compact.length > 54 ? `${compact.slice(0, 54)}…` : compact;
  return `${title || "新对话"} · ${Date.now().toString(36).slice(-5)}`;
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))} 分钟前`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3_600))} 小时前`;
  if (seconds < 604_800) return `${String(Math.floor(seconds / 86_400))} 天前`;
  return new Date(value).toLocaleDateString();
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="product-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, href }) => (
            <a href={href} rel="noreferrer noopener" target="_blank">
              {label}
            </a>
          ),
          img: ({ alt }) => <span className="product-image-placeholder">[图片：{alt ?? ""}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function ToolActivity({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const input = objectValue(displayedToolInput(item));
  const command = stringValue(input?.command);
  const path = stringValue(input?.path);
  const content = stringValue(input?.content);
  const output = item.output === undefined ? "" : toolOutputText(item.output);
  const duration = durationLabel(item.startedAt, item.completedAt);
  const conventionalWriteResult = /^Successfully wrote \d+ bytes to /u.test(output.trim());
  const statusLabel =
    item.status === "preparing"
      ? "正在生成"
      : item.status === "running"
        ? "执行中"
        : item.status === "failed"
          ? "执行失败"
          : "执行完成";
  const icon =
    item.status === "preparing" || item.status === "running"
      ? "◌"
      : item.status === "failed"
        ? "!"
        : "✓";
  const heading =
    item.toolName === "bash" && command !== null ? (
      <div className="product-tool-command">
        <span aria-hidden="true">$</span>
        <code>{command}</code>
      </div>
    ) : (
      <div className="product-tool-operation">
        <strong>{item.toolName}</strong>
        {path === null ? null : <code>{path}</code>}
      </div>
    );
  return (
    <section
      aria-label={`${item.toolName} ${statusLabel}`}
      className={`product-tool product-tool-${item.status}`}
    >
      <div className="product-tool-line">
        <span className="product-tool-icon" aria-hidden="true">
          {icon}
        </span>
        {heading}
        <span className="product-tool-state">{statusLabel}</span>
      </div>
      <div className="product-tool-body">
        {item.toolName === "write" && content !== null ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            sourcePath={path}
            streaming={item.status === "preparing"}
            text={content}
          />
        ) : item.toolName !== "bash" && path === null ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            text={safeDisplay(item.input)}
          />
        ) : null}
        {output.length > 0 && !(item.toolName === "write" && conventionalWriteResult) ? (
          <ExpandableToolText
            className={item.toolName === "bash" ? "product-tool-terminal" : "product-tool-output"}
            direction={item.toolName === "bash" ? "tail" : "head"}
            text={output}
          />
        ) : null}
        {duration === null ? null : <div className="product-tool-duration">Took {duration}</div>}
      </div>
    </section>
  );
}

function AssistantItem({
  item,
  processNarration,
}: {
  item: TranscriptItem;
  processNarration: boolean;
}) {
  if (item.kind === "text") {
    return (
      <div className={processNarration ? "product-agent-stage" : "product-agent-answer"}>
        <Markdown>{item.text}</Markdown>
      </div>
    );
  }
  if (item.kind === "tool") return <ToolActivity item={item} />;
  if (item.kind === "notification") {
    return (
      <div className={`product-notification product-notification-${item.level}`}>
        {item.message}
      </div>
    );
  }
  return (
    <div className="product-notification">
      {item.outcome === undefined
        ? `等待确认：${item.approval.title}`
        : `已处理：${item.approval.title}`}
    </div>
  );
}

function ConversationTurn({ turn }: { turn: TurnView }) {
  const working =
    turn.status === "queued" || turn.status === "running" || turn.status === "cancelling";
  const lastToolIndex = turn.items.reduce(
    (lastIndex, item, index) => (item.kind === "tool" ? index : lastIndex),
    -1,
  );
  return (
    <section
      className={`product-turn${turn.projection === "superseded" ? " product-turn-superseded" : ""}`}
      id={`turn-${turn.turnId}`}
    >
      {turn.projection === "superseded" ? (
        <div className="product-muted-line">
          此运行已被 {turn.supersededByRunId?.slice(0, 8) ?? "后续运行"}{" "}
          回退替代；原始记录仅供审计。
        </div>
      ) : null}
      {turn.rewoundFromRunId ? (
        <div className="product-muted-line">
          已恢复到运行 {turn.rewoundFromRunId.slice(0, 8)} 之前的对话与工作区。
        </div>
      ) : null}
      <div className="product-message product-user-message">
        <div className="product-user-bubble">{turn.prompt}</div>
      </div>
      <div className="product-message product-assistant-message">
        <div className="product-avatar" aria-hidden="true">
          A
        </div>
        <div className="product-assistant-content">
          {turn.items.length === 0 && working ? (
            <div className="product-thinking">
              <i />
              <i />
              <i />
              <span>正在思考</span>
            </div>
          ) : (
            turn.items.map((item, index) => (
              <AssistantItem
                item={item}
                key={item.key}
                processNarration={item.kind === "text" && index < lastToolIndex}
              />
            ))
          )}
          {turn.failure ? (
            <div className="product-turn-error">
              <strong>这次运行失败了</strong>
              <span>{turn.failure.message}</span>
            </div>
          ) : null}
          {turn.cancellation ? <div className="product-muted-line">已停止生成</div> : null}
          {turn.workspacePatch ? (
            <details className="product-patch">
              <summary>查看本轮代码修改</summary>
              <pre>{turn.workspacePatch.patch}</pre>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function AuthScreen({
  api,
  onAuthenticated,
}: {
  api: AgentDockApi;
  onAuthenticated: (identity: TenantIdentityResource) => void;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session =
        mode === "login"
          ? await api.loginAccount(username.trim().toLowerCase(), password)
          : await api.registerAccount(username.trim().toLowerCase(), displayName.trim(), password);
      onAuthenticated(session.identity);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="product-auth-page">
      <section className="product-auth-brand">
        <div className="product-logo product-logo-large" aria-hidden="true">
          A
        </div>
        <h1>AgentDock</h1>
        <p>你的云端 Coding Agent</p>
      </section>
      <form className="product-auth-card" onSubmit={(event) => void submit(event)}>
        <div className="product-auth-tabs" role="tablist" aria-label="账户操作">
          <button
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setError(null);
            }}
            role="tab"
            type="button"
          >
            登录
          </button>
          <button
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            onClick={() => {
              setMode("register");
              setError(null);
            }}
            role="tab"
            type="button"
          >
            注册
          </button>
        </div>
        <h2>{mode === "login" ? "欢迎回来" : "创建账户"}</h2>
        <p>{mode === "login" ? "登录后继续你的对话" : "注册后即可开始使用，无需配置模型"}</p>
        {mode === "register" ? (
          <label>
            <span>显示名称</span>
            <input
              autoComplete="name"
              maxLength={256}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="你希望我们如何称呼你"
              required
              value={displayName}
            />
          </label>
        ) : null}
        <label>
          <span>用户名</span>
          <input
            autoCapitalize="none"
            autoComplete="username"
            maxLength={48}
            minLength={3}
            onChange={(event) => setUsername(event.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,47}"
            placeholder="3–48 位字母、数字或 . _ -"
            required
            spellCheck={false}
            value={username}
          />
        </label>
        <label>
          <span>密码</span>
          <input
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            maxLength={128}
            minLength={10}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 10 个字符"
            required
            type="password"
            value={password}
          />
        </label>
        {error ? <div className="product-auth-error">{error}</div> : null}
        <button className="product-primary-button" disabled={busy} type="submit">
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并继续"}
        </button>
      </form>
      <footer>账户、对话和 Workspace 按租户隔离</footer>
    </main>
  );
}

export default function ChatApp() {
  const api = useMemo(() => new AgentDockApi(), []);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [identity, setIdentity] = useState<TenantIdentityResource | null>(null);
  const [state, setState] = useState(createInitialSessionView);
  const [conversations, setConversations] = useState<readonly ConversationSummaryResource[]>([]);
  const [conversationLoading, setConversationLoading] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [operation, setOperation] = useState<"creating" | "submitting" | "cancelling" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorRefreshSignal, setInspectorRefreshSignal] = useState(0);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSourceKind, setWorkspaceSourceKind] =
    useState<WorkspaceSourceRequest["kind"]>("empty");
  const [workspaceRepository, setWorkspaceRepository] = useState("");
  const [workspaceCommitSha, setWorkspaceCommitSha] = useState("");
  const [workspaceInstallationId, setWorkspaceInstallationId] = useState("");
  const [workspaceRepositoryId, setWorkspaceRepositoryId] = useState("");
  const [workspaceRepositorySet, setWorkspaceRepositorySet] = useState("");
  const [githubInstallation, setGitHubInstallation] = useState<GitHubInstallationResource | null>(
    null,
  );
  const [githubLoading, setGitHubLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfigurationResource | null>(
    null,
  );
  const [selectedModelId, setSelectedModelId] = useState<DeepSeekModelId>("deepseek-v4-flash");
  const [modelApiKey, setModelApiKey] = useState("");
  const [cubeProxyConfiguration, setCubeProxyConfiguration] =
    useState<CubeProxyConfigurationResource | null>(null);
  const [cubeProxyEnabled, setCubeProxyEnabled] = useState(false);
  const [cubeProxyUrl, setCubeProxyUrl] = useState("");
  const [settingsSaving, setSettingsSaving] = useState<"model" | "proxy" | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const lastSequenceRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const currentTurn = activeTurn(state);
  const canMutate = identity?.role !== "viewer";
  const canQueue =
    state.session === null ||
    state.sessionState === "cold" ||
    state.sessionState === "idle" ||
    state.sessionState === "running" ||
    state.sessionState === "waiting_approval" ||
    state.sessionState === "cancelling";

  const update = useCallback((action: Parameters<typeof sessionViewReducer>[1]) => {
    setState((current) => sessionViewReducer(current, action));
  }, []);

  const refreshConversations = useCallback(async (): Promise<void> => {
    const listed = await api.listConversations();
    setConversations(listed.conversations);
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void api.getIdentity().then(
      (resolved) => {
        if (cancelled) return;
        setIdentity(resolved);
        setAuthPhase("authenticated");
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof AgentDockApiError && error.status === 401) {
          setIdentity(null);
          setAuthPhase("anonymous");
          return;
        }
        setIdentity(null);
        setAuthPhase("anonymous");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (authPhase !== "authenticated") return;
    let cancelled = false;
    void api.listConversations().then(
      (listed) => {
        if (!cancelled) setConversations(listed.conversations);
      },
      (error: unknown) => {
        if (!cancelled) update({ type: "api.error", message: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, authPhase, identity?.tenantId, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.role !== "owner") {
      setCubeProxyConfiguration(null);
      setModelConfiguration(null);
      return;
    }
    let cancelled = false;
    void api
      .getCubeProxyConfiguration()
      .then(async (proxyConfiguration) => {
        if (cancelled) return;
        setCubeProxyConfiguration(proxyConfiguration);
        setCubeProxyEnabled(proxyConfiguration.enabled);
        setCubeProxyUrl(proxyConfiguration.proxyUrl ?? "");
        const model = await api.getModelConfiguration();
        if (cancelled) return;
        setModelConfiguration(model);
        if (model.mode === "real") setSelectedModelId(model.modelId);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof AgentDockApiError && error.status === 403) {
          setCubeProxyConfiguration(null);
          setModelConfiguration(null);
          return;
        }
        update({ type: "api.error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, authPhase, identity?.role, identity?.tenantId, update]);

  useEffect(() => {
    const sessionId = state.session?.sessionId;
    if (sessionId === undefined || authPhase !== "authenticated") return;
    const controller = new AbortController();
    void streamSessionEvents({
      sessionId,
      afterSequence: lastSequenceRef.current,
      signal: controller.signal,
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
        update({ type: "api.error", message: "实时连接已中断，正在等待重新连接。" });
      }
    });
    return () => controller.abort();
  }, [authPhase, reconnectGeneration, refreshConversations, state.session?.sessionId, update]);

  // A Run can fail before the trusted Runner publishes its first session
  // event (for example during Sandbox provisioning). The durable Run record is
  // therefore the terminal-state fallback for the streaming transcript.
  useEffect(() => {
    const runId = currentTurn?.runId;
    if (runId === null || runId === undefined || authPhase !== "authenticated") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const run = await api.getRun(runId);
        if (cancelled) return;
        update({ type: "run.reconciled", run });
        if (
          run.state === "completed" ||
          run.state === "failed" ||
          run.state === "cancelled" ||
          run.state === "timed_out" ||
          run.state === "superseded"
        ) {
          setInspectorRefreshSignal((value) => value + 1);
          if (state.session !== null) {
            const detail = await api.getConversation(state.session.sessionId).catch(() => null);
            if (!cancelled && detail !== null) {
              update({
                type: "project.environment.refreshed",
                environment: detail.project.environment,
              });
            }
          }
          await refreshConversations().catch(() => undefined);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      timer = setTimeout(() => void poll(), 1_000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, authPhase, currentTurn?.runId, refreshConversations, state.session, update]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.lastSequence, state.turns.length]);

  function resetConversation(): void {
    lastSequenceRef.current = 0;
    setState(createInitialSessionView());
    setPrompt("");
    setInspectorOpen(false);
    setSidebarOpen(false);
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      /* The local session is cleared even if logout races expiry. */
    }
    resetConversation();
    setConversations([]);
    setSettingsOpen(false);
    setModelConfiguration(null);
    setModelApiKey("");
    setCubeProxyConfiguration(null);
    setCubeProxyEnabled(false);
    setCubeProxyUrl("");
    setIdentity(null);
    setAuthPhase("anonymous");
  }

  async function saveModelConfiguration(): Promise<void> {
    if (cubeProxyConfiguration === null || settingsSaving !== null) return;
    const apiKey = modelApiKey.trim();
    if (!/^[A-Za-z0-9._-]{16,512}$/.test(apiKey)) {
      update({ type: "api.error", message: "DeepSeek API Key 格式无效。" });
      return;
    }
    setSettingsSaving("model");
    update({ type: "api.error.cleared" });
    try {
      const configured = await api.replaceModelConfiguration(selectedModelId, apiKey);
      setModelConfiguration(configured);
      setModelApiKey("");
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setSettingsSaving(null);
    }
  }

  async function saveCubeProxyConfiguration(): Promise<void> {
    if (cubeProxyConfiguration === null || settingsSaving !== null) return;
    const proxyUrl = cubeProxyUrl.trim();
    if (cubeProxyEnabled && proxyUrl.length === 0) {
      update({ type: "api.error", message: "启用 Cube 联网前需要填写上游代理地址。" });
      return;
    }
    setSettingsSaving("proxy");
    update({ type: "api.error.cleared" });
    try {
      const configured = await api.replaceCubeProxyConfiguration(
        cubeProxyEnabled,
        proxyUrl.length === 0 ? undefined : proxyUrl,
      );
      setCubeProxyConfiguration(configured);
      setCubeProxyEnabled(configured.enabled);
      setCubeProxyUrl(configured.proxyUrl ?? "");
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setSettingsSaving(null);
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
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setConversationLoading(null);
    }
  }

  async function openConversationById(sessionId: string): Promise<void> {
    const detail = await api.getConversation(sessionId);
    lastSequenceRef.current = detail.replayAfterSequence;
    update({ type: "conversation.loaded", conversation: detail });
    await refreshConversations();
  }

  async function provisionSession(name: string, source: WorkspaceSourceRequest) {
    setOperation("creating");
    try {
      const project = await api.createProject(name, source);
      const session = await api.createSession(project);
      lastSequenceRef.current = 0;
      update({ type: "session.created", project, session });
      await refreshConversations();
      return session;
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
      return undefined;
    } finally {
      setOperation(null);
    }
  }

  async function createWorkspace(): Promise<void> {
    const name = workspaceName.trim();
    if (name.length === 0) return;
    let source: WorkspaceSourceRequest;
    try {
      source =
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
              : workspaceSourceKind === "github_app"
                ? {
                    kind: "github_app",
                    installationId: Number(workspaceInstallationId),
                    repositoryId: Number(workspaceRepositoryId),
                    commitSha: workspaceCommitSha.trim(),
                  }
                : parseRepositorySetManifest(workspaceRepositorySet);
    } catch (error: unknown) {
      update({
        type: "api.error",
        message: error instanceof Error ? error.message : "多仓库清单格式无效。",
      });
      return;
    }
    const session = await provisionSession(name, source);
    if (session !== undefined) {
      setWorkspacePanelOpen(false);
      setWorkspaceName("");
      setWorkspaceRepository("");
      setWorkspaceCommitSha("");
      setWorkspaceInstallationId("");
      setWorkspaceRepositoryId("");
      setWorkspaceRepositorySet("");
      setGitHubInstallation(null);
    }
  }

  async function loadGitHubInstallation(): Promise<void> {
    const installationId = Number(workspaceInstallationId);
    if (!Number.isSafeInteger(installationId) || installationId < 1) return;
    setGitHubLoading(true);
    try {
      const installation =
        identity?.role === "owner"
          ? await api.registerGitHubInstallation(installationId)
          : await api.getGitHubInstallation(installationId);
      setGitHubInstallation(installation);
      setWorkspaceRepositoryId(
        String(installation.repositories.find((item) => item.enabled)?.repositoryId ?? ""),
      );
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setGitHubLoading(false);
    }
  }

  async function submitTurn(): Promise<void> {
    const text = prompt.trim();
    if (!text || !canMutate || !canQueue || operation !== null) return;
    setOperation("submitting");
    update({ type: "api.error.cleared" });
    try {
      let session = state.session;
      if (session === null) {
        const project = await api.createProject(conversationTitle(text), { kind: "empty" });
        session = await api.createSession(project);
        lastSequenceRef.current = 0;
        update({ type: "session.created", project, session });
        await refreshConversations();
      }
      const accepted = await api.acceptTurn(
        session.sessionId,
        text,
        newIdempotencyKey("turn"),
        "off",
      );
      update({ type: "turn.accepted", accepted, prompt: text });
      setPrompt("");
      await refreshConversations();
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function cancelTurn(): Promise<void> {
    if (state.session === null || currentTurn?.status !== "running" || operation !== null) return;
    setOperation("cancelling");
    try {
      await api.cancelTurn(
        state.session.sessionId,
        currentTurn.turnId,
        newIdempotencyKey("cancel"),
      );
      update({ type: "turn.cancellation.requested", turnId: currentTurn.turnId });
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function retryRun(runId: string, sourceAttemptId: string): Promise<void> {
    if (state.session === null || operation !== null || currentTurn !== undefined) return;
    const run = await api.getRun(runId);
    const original = state.turns.find((turn) => turn.turnId === run.turnId);
    if (original === undefined) return;
    setOperation("submitting");
    update({ type: "api.error.cleared" });
    try {
      const rewind = await api.rewindRun(runId, sourceAttemptId, newIdempotencyKey("retry"));
      update({ type: "turn.accepted", accepted: rewind.acceptedTurn, prompt: original.prompt });
      setPrompt("");
      setInspectorRefreshSignal((value) => value + 1);
      await refreshConversations();
    } finally {
      setOperation(null);
    }
  }

  if (authPhase === "checking") {
    return (
      <main className="product-loading-page">
        <div className="product-logo product-logo-large">A</div>
        <span>AgentDock · 正在恢复登录状态…</span>
      </main>
    );
  }
  if (authPhase === "anonymous" || identity === null) {
    return (
      <AuthScreen
        api={api}
        onAuthenticated={(resolved) => {
          setIdentity(resolved);
          setAuthPhase("authenticated");
        }}
      />
    );
  }

  return (
    <div className="product-shell">
      <button
        aria-label="关闭侧边栏"
        className={`product-sidebar-backdrop ${sidebarOpen ? "visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
        type="button"
      />
      <aside className={`product-sidebar ${sidebarOpen ? "open" : ""}`}>
        <header className="product-sidebar-brand">
          <div className="product-logo">A</div>
          <strong>AgentDock</strong>
        </header>
        <div className="product-sidebar-actions">
          <button className="product-new-chat" onClick={resetConversation} type="button">
            <span>＋</span> 新对话
          </button>
          <button
            className="product-import-button"
            onClick={() => {
              setWorkspaceSourceKind("github_public");
              setWorkspaceName("");
              setWorkspacePanelOpen(true);
              setSidebarOpen(false);
            }}
            type="button"
          >
            导入项目
          </button>
        </div>
        <nav className="product-conversation-list" aria-label="对话列表">
          <span className="product-sidebar-label">最近对话</span>
          {conversations.length === 0 ? (
            <div className="product-conversation-empty">还没有对话</div>
          ) : (
            conversations.map((conversation) => (
              <button
                className={state.session?.sessionId === conversation.sessionId ? "active" : ""}
                disabled={conversationLoading !== null || operation !== null}
                key={conversation.sessionId}
                onClick={() => void openConversation(conversation)}
                type="button"
              >
                <strong>{conversation.projectName}</strong>
                <small>{relativeTime(conversation.lastActiveAt)}</small>
              </button>
            ))
          )}
        </nav>
        <footer className="product-account">
          <div className="product-account-avatar">
            {identity.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <strong>{identity.displayName}</strong>
            <span>@{identity.tenantSlug}</span>
          </div>
          <button
            aria-label="退出登录"
            onClick={() => void logout()}
            title="退出登录"
            type="button"
          >
            ↪
          </button>
        </footer>
      </aside>

      <main className="product-main">
        <header className="product-topbar">
          <button
            className="product-mobile-menu"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            ☰
          </button>
          <div className="product-topbar-title">
            <strong>{state.project?.name ?? "新对话"}</strong>
            {state.session ? (
              <span className={state.connection.phase === "live" ? "online" : ""}>
                {state.connection.phase === "live" ? "已连接" : "连接中"}
              </span>
            ) : null}
            {state.project ? (
              <span
                className={`product-environment-badge product-environment-${state.project.environment.state}`}
                title={
                  state.project.environment.latestValidation === undefined
                    ? `镜像 ${state.project.environment.imageRevision}`
                    : state.project.environment.latestValidation.tools
                        .map((tool) => `${tool.name} ${tool.version}`)
                        .join(" · ")
                }
              >
                Env v{String(state.project.environment.versionNumber)} ·{" "}
                {state.project.environment.state === "validated"
                  ? "gVisor 已验证"
                  : state.project.environment.state === "failed"
                    ? "验证失败"
                    : "等待首次工具调用"}
              </span>
            ) : null}
          </div>
          <div className="product-topbar-actions">
            {state.connection.phase === "failed" ? (
              <button onClick={() => setReconnectGeneration((value) => value + 1)} type="button">
                重新连接
              </button>
            ) : null}
            {cubeProxyConfiguration !== null ? (
              <button onClick={() => setSettingsOpen(true)} type="button">
                设置
              </button>
            ) : null}
            <button
              disabled={state.session === null}
              onClick={() => setInspectorOpen((value) => !value)}
              type="button"
            >
              工作区
            </button>
          </div>
        </header>

        {workspacePanelOpen ? (
          <div className="product-modal-backdrop" role="presentation">
            <form
              className="product-workspace-modal"
              onSubmit={(event) => {
                event.preventDefault();
                void createWorkspace();
              }}
            >
              <header>
                <div>
                  <h2>开始一个项目对话</h2>
                  <p>选择空 Workspace 或导入固定版本的代码仓库。</p>
                </div>
                <button onClick={() => setWorkspacePanelOpen(false)} type="button">
                  ×
                </button>
              </header>
              <label>
                <span>对话名称</span>
                <input
                  maxLength={256}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="例如：重构订单服务"
                  required
                  value={workspaceName}
                />
              </label>
              <label>
                <span>项目来源</span>
                <select
                  onChange={(event) =>
                    setWorkspaceSourceKind(event.target.value as WorkspaceSourceRequest["kind"])
                  }
                  value={workspaceSourceKind}
                >
                  <option value="empty">空 Workspace</option>
                  <option value="github_public">公开 GitHub 仓库</option>
                  <option value="github_app">GitHub App 私有仓库</option>
                  <option value="repository_set">多仓库精确版本</option>
                  <option value="sample_java">Java 修复示例</option>
                </select>
              </label>
              {workspaceSourceKind === "github_public" ? (
                <>
                  <label>
                    <span>仓库</span>
                    <input
                      onChange={(event) => setWorkspaceRepository(event.target.value)}
                      placeholder="owner/repository"
                      required
                      value={workspaceRepository}
                    />
                  </label>
                  <label>
                    <span>Commit SHA</span>
                    <input
                      maxLength={40}
                      minLength={40}
                      onChange={(event) => setWorkspaceCommitSha(event.target.value)}
                      pattern="[0-9a-f]{40}"
                      placeholder="40 位小写 SHA"
                      required
                      value={workspaceCommitSha}
                    />
                  </label>
                </>
              ) : null}
              {workspaceSourceKind === "github_app" ? (
                <div className="product-github-fields">
                  <label>
                    <span>Installation ID</span>
                    <input
                      min="1"
                      onChange={(event) => {
                        setWorkspaceInstallationId(event.target.value);
                        setGitHubInstallation(null);
                      }}
                      type="number"
                      value={workspaceInstallationId}
                    />
                  </label>
                  <button
                    disabled={githubLoading || !workspaceInstallationId}
                    onClick={() => void loadGitHubInstallation()}
                    type="button"
                  >
                    {githubLoading ? "同步中…" : "同步仓库"}
                  </button>
                  <label>
                    <span>仓库</span>
                    <select
                      disabled={githubInstallation === null}
                      onChange={(event) => setWorkspaceRepositoryId(event.target.value)}
                      value={workspaceRepositoryId}
                    >
                      <option value="">选择仓库</option>
                      {githubInstallation?.repositories
                        .filter((item) => item.enabled)
                        .map((item) => (
                          <option key={item.repositoryId} value={item.repositoryId}>
                            {item.fullName}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <span>Commit SHA</span>
                    <input
                      maxLength={40}
                      minLength={40}
                      onChange={(event) => setWorkspaceCommitSha(event.target.value)}
                      pattern="[0-9a-f]{40}"
                      value={workspaceCommitSha}
                    />
                  </label>
                </div>
              ) : null}
              {workspaceSourceKind === "repository_set" ? (
                <label>
                  <span>仓库清单（2–8 个，JSON）</span>
                  <textarea
                    onChange={(event) => setWorkspaceRepositorySet(event.target.value)}
                    placeholder={REPOSITORY_SET_EXAMPLE}
                    required
                    rows={12}
                    spellCheck={false}
                    value={workspaceRepositorySet}
                  />
                  <small>
                    每个仓库必须固定到 40 位 Commit SHA，并映射到唯一顶层目录。清单也支持 github_app
                    条目。
                  </small>
                </label>
              ) : null}
              <footer>
                <button onClick={() => setWorkspacePanelOpen(false)} type="button">
                  取消
                </button>
                <button
                  className="product-primary-button"
                  disabled={operation !== null}
                  type="submit"
                >
                  {operation === "creating" ? "创建中…" : "创建对话"}
                </button>
              </footer>
            </form>
          </div>
        ) : null}

        {settingsOpen && cubeProxyConfiguration !== null ? (
          <div className="product-modal-backdrop" role="presentation">
            <section
              aria-label="平台运行配置"
              aria-modal="true"
              className="product-workspace-modal product-settings-modal"
              role="dialog"
            >
              <header>
                <div>
                  <h2>平台运行配置</h2>
                  <p>配置写入持久化控制面，新任务或新连接热生效，无需重启集群。</p>
                </div>
                <button onClick={() => setSettingsOpen(false)} type="button">
                  ×
                </button>
              </header>

              <div className="product-settings-section">
                <div>
                  <h3>Pi Worker 模型</h3>
                  <p>Key 加密保存且不会进入 Cube。正在运行的任务保留启动时的模型快照。</p>
                </div>
                <label>
                  <span>模型</span>
                  <select
                    disabled={settingsSaving !== null}
                    onChange={(event) => setSelectedModelId(event.target.value as DeepSeekModelId)}
                    value={selectedModelId}
                  >
                    <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                    <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                  </select>
                </label>
                <label>
                  <span>API Key</span>
                  <input
                    autoComplete="off"
                    disabled={settingsSaving !== null}
                    onChange={(event) => setModelApiKey(event.target.value)}
                    placeholder={modelConfiguration?.mode === "real" ? "输入新 Key 以轮换" : "sk-…"}
                    spellCheck={false}
                    type="password"
                    value={modelApiKey}
                  />
                </label>
                <div className="product-settings-action">
                  <small>
                    当前凭据版本{" "}
                    {modelConfiguration === null
                      ? "读取中"
                      : String(modelConfiguration.credentialVersion)}
                  </small>
                  <button
                    className="product-primary-button"
                    disabled={settingsSaving !== null || modelApiKey.trim() === ""}
                    onClick={() => void saveModelConfiguration()}
                    type="button"
                  >
                    {settingsSaving === "model" ? "加密并发布中…" : "更新模型配置"}
                  </button>
                </div>
              </div>

              <div className="product-settings-section">
                <div>
                  <h3>CubeSandbox 公网代理</h3>
                  <p>MicroVM 只能连接可信网关。配置刷新后，新 HTTP/HTTPS 连接使用最新版本。</p>
                </div>
                <label className="product-settings-toggle">
                  <input
                    checked={cubeProxyEnabled}
                    disabled={settingsSaving !== null}
                    onChange={(event) => setCubeProxyEnabled(event.target.checked)}
                    type="checkbox"
                  />
                  <span>允许代理感知的软件访问公网 HTTP/HTTPS</span>
                </label>
                <label>
                  <span>WSL / 宿主机上游代理</span>
                  <input
                    autoComplete="off"
                    disabled={settingsSaving !== null}
                    onChange={(event) => setCubeProxyUrl(event.target.value)}
                    placeholder="http://127.0.0.1:7890"
                    spellCheck={false}
                    type="url"
                    value={cubeProxyUrl}
                  />
                </label>
                <div className="product-settings-action">
                  <small>当前代理版本 {String(cubeProxyConfiguration.revision)}</small>
                  <button
                    className="product-primary-button"
                    disabled={
                      settingsSaving !== null || (cubeProxyEnabled && cubeProxyUrl.trim() === "")
                    }
                    onClick={() => void saveCubeProxyConfiguration()}
                    type="button"
                  >
                    {settingsSaving === "proxy" ? "发布中…" : "应用代理配置"}
                  </button>
                </div>
              </div>

              <footer>
                <button
                  disabled={settingsSaving !== null}
                  onClick={() => setSettingsOpen(false)}
                  type="button"
                >
                  关闭
                </button>
              </footer>
            </section>
          </div>
        ) : null}

        {state.apiError ? (
          <div className="product-error-banner">
            <span>{state.apiError}</span>
            <button onClick={() => update({ type: "api.error.cleared" })} type="button">
              ×
            </button>
          </div>
        ) : null}

        <div className={`product-content ${inspectorOpen ? "with-inspector" : ""}`}>
          <section className="product-chat-scroll">
            {state.turns.length === 0 ? (
              <div className="product-welcome">
                <div className="product-logo product-logo-large">A</div>
                <h1>你好，{identity.displayName}</h1>
                <p>今天想让 AgentDock 帮你完成什么？</p>
                <div className="product-examples">
                  {EXAMPLE_PROMPTS.map((example) => (
                    <button key={example} onClick={() => setPrompt(example)} type="button">
                      {example}
                      <span>→</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="product-transcript">
                {state.turns.map((turn) => (
                  <ConversationTurn key={turn.turnId} turn={turn} />
                ))}
                <div ref={transcriptEndRef} />
              </div>
            )}
          </section>
          {inspectorOpen ? (
            <WorkspaceInspector
              api={api}
              busy={currentTurn !== undefined || operation !== null}
              onClose={() => setInspectorOpen(false)}
              onError={(message) => update({ type: "api.error", message })}
              onForked={openConversationById}
              onRetry={retryRun}
              onSessionChanged={refreshConversations}
              refreshSignal={inspectorRefreshSignal}
              role={identity.role}
              projectId={state.project?.projectId ?? null}
              sessionId={state.session?.sessionId ?? null}
              source={state.project?.source ?? null}
            />
          ) : null}
        </div>

        <footer className="product-composer-area">
          <div className="product-composer">
            <textarea
              aria-label="发送消息"
              disabled={!canMutate || !canQueue || operation !== null}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitTurn();
                }
              }}
              placeholder={
                currentTurn ? "继续输入，消息会在当前任务后执行" : "给 AgentDock 发送消息"
              }
              rows={1}
              value={prompt}
            />
            {currentTurn?.status === "running" ? (
              <button
                className="product-stop-button"
                onClick={() => void cancelTurn()}
                title="停止"
                type="button"
              >
                ■
              </button>
            ) : (
              <button
                className="product-send-button"
                disabled={!prompt.trim() || operation !== null}
                onClick={() => void submitTurn()}
                title="发送"
                type="button"
              >
                ↑
              </button>
            )}
          </div>
          <small>Agent 可能会出错，请检查重要的代码修改和测试结果。</small>
        </footer>
      </main>
    </div>
  );
}
