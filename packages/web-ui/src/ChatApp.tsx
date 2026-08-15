import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationTreeResource,
  ConversationTreeView,
  ConversationSummaryResource,
  SandboxRetentionPolicy,
  TenantIdentityResource,
  WorkspaceSummaryResource,
} from "@agent-dock/protocol";
import { AgentDockApi, AgentDockApiError, newIdempotencyKey } from "./api.ts";
import { AdminPage } from "./AdminPage.tsx";
import { AuthScreen } from "./AuthScreen.tsx";
import { ConversationTreeNavigator } from "./ConversationTreeNavigator.tsx";
import { ConversationTurn } from "./ConversationTurn.tsx";
import { activeTurn, createInitialSessionView, sessionViewReducer } from "./session-view.ts";
import { streamSessionEvents } from "./sse.ts";
import { errorMessage } from "./ui-errors.ts";
import { WorkspaceInspector } from "./WorkspaceInspector.tsx";
import { useResizablePanel } from "./use-resizable-panel.ts";

type AuthPhase = "checking" | "anonymous" | "authenticated";

const EXAMPLE_PROMPTS = [
  "帮我分析这个项目，并说明它的核心架构",
  "实现一个 REST API，并补充单元测试",
  "检查当前代码中的 bug，修复后运行测试",
] as const;

function conversationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 54)}…` : compact || "新对话";
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

export default function ChatApp() {
  const api = useMemo(() => new AgentDockApi(), []);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [identity, setIdentity] = useState<TenantIdentityResource | null>(null);
  const [state, setState] = useState(createInitialSessionView);
  const [conversations, setConversations] = useState<readonly ConversationSummaryResource[]>([]);
  const [conversationTree, setConversationTree] = useState<ConversationTreeResource | null>(null);
  const [treeView, setTreeView] = useState<ConversationTreeView>("focus");
  const [treeLoading, setTreeLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummaryResource[]>([]);
  const [conversationLoading, setConversationLoading] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [operation, setOperation] = useState<
    "creating" | "submitting" | "cancelling" | "steering" | "forking" | "deleting-workspace" | null
  >(null);
  const [steerNotice, setSteerNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorRefreshSignal, setInspectorRefreshSignal] = useState(0);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [workspaceChoice, setWorkspaceChoice] = useState<"existing" | "new">("new");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [sandboxRetention, setSandboxRetention] = useState<SandboxRetentionPolicy>("ephemeral");
  const [pendingInitialPrompt, setPendingInitialPrompt] = useState<string | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [pendingTreeJump, setPendingTreeJump] = useState<string | null>(null);
  const [forkTarget, setForkTarget] = useState<{
    sourceSessionId: string;
    turnId: string;
    entryId: string;
  } | null>(null);
  const [forkTitle, setForkTitle] = useState("");
  const lastSequenceRef = useRef(0);
  const chatScrollerRef = useRef<HTMLElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const currentTurn = activeTurn(state);
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.workspaceId === selectedWorkspaceId,
  );
  const conversationPanel = useResizablePanel({
    storageKey: "agent-dock:conversation-list",
    initialWidth: 260,
    minimumWidth: 210,
    maximumWidth: 420,
  });
  const canMutate = identity?.role !== "viewer";
  const canQueue =
    state.session === null ||
    state.sessionState === "cold" ||
    state.sessionState === "idle" ||
    state.sessionState === "running" ||
    state.sessionState === "waiting_approval" ||
    state.sessionState === "cancelling";
  const forkTargets = useMemo(() => {
    const targets = new Map<string, { sourceSessionId: string; turnId: string; entryId: string }>();
    for (const branch of conversationTree?.branches ?? []) {
      for (const entry of branch.entries) {
        if (!entry.finalAssistant) continue;
        targets.set(entry.turnId, {
          sourceSessionId: branch.sessionId,
          turnId: entry.turnId,
          entryId: entry.entryId,
        });
      }
    }
    return targets;
  }, [conversationTree]);

  const update = useCallback((action: Parameters<typeof sessionViewReducer>[1]) => {
    setState((current) => sessionViewReducer(current, action));
  }, []);

  const refreshConversations = useCallback(async (): Promise<void> => {
    const listed = await api.listConversations();
    setConversations(listed.conversations);
  }, [api]);

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    const listed = await api.listWorkspaces();
    setWorkspaces(listed.workspaces);
    setSelectedWorkspaceId((current) =>
      listed.workspaces.some((workspace) => workspace.workspaceId === current)
        ? current
        : (listed.workspaces[0]?.workspaceId ?? ""),
    );
  }, [api]);

  const refreshConversationTree = useCallback(
    async (sessionId: string, view: ConversationTreeView): Promise<void> => {
      setTreeLoading(true);
      try {
        setConversationTree(await api.getConversationTree(sessionId, view));
      } finally {
        setTreeLoading(false);
      }
    },
    [api],
  );

  const loadConversation = useCallback(
    async (sessionId: string) => {
      const conversation = await api.getConversation(sessionId);
      const liveSnapshot = await api.getLiveTurnSnapshot(sessionId).catch(() => undefined);
      const replayAfterSequence =
        liveSnapshot?.turn === null || liveSnapshot === undefined
          ? conversation.replayAfterSequence
          : liveSnapshot.replayAfterSequence;
      return { conversation, liveSnapshot, replayAfterSequence };
    },
    [api],
  );

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
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
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
  }, [api, authPhase, identity?.platformAdministrator, identity?.tenantId, update]);

  useEffect(() => {
    if (authPhase !== "authenticated" || identity?.platformAdministrator === true) return;
    void refreshWorkspaces().catch((error: unknown) => {
      update({ type: "api.error", message: errorMessage(error) });
    });
  }, [authPhase, identity?.platformAdministrator, identity?.tenantId, refreshWorkspaces, update]);

  useEffect(() => {
    const sessionId = state.session?.sessionId;
    if (authPhase !== "authenticated" || sessionId === undefined) {
      setConversationTree(null);
      return;
    }
    let cancelled = false;
    setTreeLoading(true);
    void api
      .getConversationTree(sessionId, treeView)
      .then(
        (tree) => {
          if (!cancelled) setConversationTree(tree);
        },
        (error: unknown) => {
          if (!cancelled) update({ type: "api.error", message: errorMessage(error) });
        },
      )
      .finally(() => {
        if (!cancelled) setTreeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, authPhase, state.session?.sessionId, treeView, update]);

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
          void refreshConversationTree(sessionId, treeView).catch(() => undefined);
        }
      },
      onStatus(status) {
        update({ type: "stream.status", status });
      },
      async onCursorExpired() {
        const loaded = await loadConversation(sessionId);
        lastSequenceRef.current = loaded.replayAfterSequence;
        update({
          type: "conversation.loaded",
          conversation: loaded.conversation,
          ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
        });
        return loaded.replayAfterSequence;
      },
    }).catch(() => {
      if (!controller.signal.aborted) {
        update({ type: "api.error", message: "实时连接已中断，正在等待重新连接。" });
      }
    });
    return () => controller.abort();
  }, [
    api,
    authPhase,
    loadConversation,
    reconnectGeneration,
    refreshConversations,
    refreshConversationTree,
    state.session?.sessionId,
    treeView,
    update,
  ]);

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

  useEffect(() => {
    if (pendingTreeJump === null) return;
    const target = chatScrollerRef.current?.querySelector<HTMLElement>(
      `[data-conversation-turn-id="${pendingTreeJump}"]`,
    );
    if (target === undefined || target === null) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingTreeJump(null);
  }, [pendingTreeJump, state.session?.sessionId, state.turns.length]);

  function resetConversation(): void {
    lastSequenceRef.current = 0;
    setState(createInitialSessionView());
    setPrompt("");
    setInspectorOpen(false);
    setSidebarOpen(false);
    setConversationTree(null);
    setPendingTreeJump(null);
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      /* The local session is cleared even if logout races expiry. */
    }
    resetConversation();
    setConversations([]);
    setWorkspaces([]);
    setIdentity(null);
    setAuthPhase("anonymous");
  }

  async function openConversationSession(
    sessionId: string,
    jumpToTurnId?: string,
    allowDuringOperation = false,
  ): Promise<void> {
    if (conversationLoading !== null || (!allowDuringOperation && operation !== null)) return;
    setConversationLoading(sessionId);
    update({ type: "api.error.cleared" });
    try {
      const loaded = await loadConversation(sessionId);
      lastSequenceRef.current = loaded.replayAfterSequence;
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
        ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
      });
      if (jumpToTurnId !== undefined) setPendingTreeJump(jumpToTurnId);
      setSidebarOpen(false);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setConversationLoading(null);
    }
  }

  async function openConversation(conversation: ConversationSummaryResource): Promise<void> {
    return openConversationSession(conversation.sessionId);
  }

  async function createConversationFork(): Promise<void> {
    if (forkTarget === null || operation !== null) return;
    setOperation("forking");
    update({ type: "api.error.cleared" });
    try {
      const title = forkTitle.trim();
      const forked = await api.forkConversation(
        forkTarget.sourceSessionId,
        forkTarget.turnId,
        forkTarget.entryId,
        title.length === 0 ? undefined : title,
        newIdempotencyKey("fork"),
      );
      setTreeView("focus");
      setForkTarget(null);
      setForkTitle("");
      await Promise.all([
        openConversationSession(forked.session.sessionId, forkTarget.turnId, true),
        refreshConversations(),
      ]);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  function beginNewConversation(initialPrompt: string | null = null): void {
    resetConversation();
    setPendingInitialPrompt(initialPrompt);
    setNewConversationTitle(initialPrompt === null ? "" : conversationTitle(initialPrompt));
    setWorkspaceChoice(workspaces.length === 0 ? "new" : "existing");
    setSelectedWorkspaceId(workspaces[0]?.workspaceId ?? "");
    setNewWorkspaceName("");
    setSandboxRetention("ephemeral");
    setWorkspacePanelOpen(true);
  }

  async function createConversation(): Promise<void> {
    const title = newConversationTitle.trim();
    if (title.length === 0 || operation !== null) return;
    setOperation("creating");
    update({ type: "api.error.cleared" });
    try {
      let projectId: string;
      let workspaceId: string;
      if (workspaceChoice === "new") {
        const name = newWorkspaceName.trim();
        if (name.length === 0) return;
        const created = await api.createProject(name);
        projectId = created.projectId;
        workspaceId = created.workspaceId;
      } else {
        const selected = workspaces.find(
          (workspace) => workspace.workspaceId === selectedWorkspaceId,
        );
        if (selected === undefined) {
          update({ type: "api.error", message: "请选择一个 Workspace。" });
          return;
        }
        projectId = selected.projectId;
        workspaceId = selected.workspaceId;
      }
      const session = await api.createSession(projectId, workspaceId, title, sandboxRetention);
      const loaded = await loadConversation(session.sessionId);
      lastSequenceRef.current = loaded.replayAfterSequence;
      update({
        type: "conversation.loaded",
        conversation: loaded.conversation,
        ...(loaded.liveSnapshot === undefined ? {} : { liveSnapshot: loaded.liveSnapshot }),
      });
      setWorkspacePanelOpen(false);
      await Promise.all([refreshConversations(), refreshWorkspaces()]);
      if (pendingInitialPrompt !== null) {
        const accepted = await api.acceptTurn(
          session.sessionId,
          pendingInitialPrompt,
          newIdempotencyKey("turn"),
          "off",
        );
        update({ type: "turn.accepted", accepted, prompt: pendingInitialPrompt });
        setPrompt("");
      }
      setPendingInitialPrompt(null);
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function deleteConversation(conversation: ConversationSummaryResource): Promise<void> {
    if (
      operation !== null ||
      !window.confirm(`删除对话“${conversation.title}”？Workspace 文件不会被删除。`)
    ) {
      return;
    }
    setOperation("creating");
    try {
      await api.deleteConversation(conversation.sessionId, newIdempotencyKey("delete"));
      if (state.session?.sessionId === conversation.sessionId) resetConversation();
      await refreshConversations();
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  }

  async function deleteWorkspace(workspace: WorkspaceSummaryResource): Promise<void> {
    if (
      operation !== null ||
      workspace.sessionCount > 0 ||
      !window.confirm(`永久删除 Workspace“${workspace.name}”及其中的全部文件？此操作无法撤销。`)
    ) {
      return;
    }
    setOperation("deleting-workspace");
    update({ type: "api.error.cleared" });
    try {
      await api.deleteWorkspace(workspace.workspaceId, newIdempotencyKey("delete"));
      await refreshWorkspaces();
      if (workspaces.length === 1) setWorkspaceChoice("new");
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
    } finally {
      setOperation(null);
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
        setOperation(null);
        beginNewConversation(text);
        return;
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

  async function steerTurn(): Promise<void> {
    const text = prompt.trim();
    if (
      state.session === null ||
      currentTurn?.status !== "running" ||
      !text ||
      operation !== null
    ) {
      return;
    }
    setOperation("steering");
    setSteerNotice(null);
    update({ type: "api.error.cleared" });
    try {
      await api.steerTurn(
        state.session.sessionId,
        currentTurn.turnId,
        text,
        newIdempotencyKey("steer"),
      );
      setPrompt("");
      setSteerNotice("已引导当前任务；Pi 会在当前工具调用结束后、下一次模型调用前处理。");
    } catch (error: unknown) {
      update({ type: "api.error", message: errorMessage(error) });
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
  if (identity.platformAdministrator) {
    return <AdminPage api={api} identity={identity} onLogout={() => void logout()} />;
  }

  return (
    <div className="product-shell">
      <button
        aria-label="关闭侧边栏"
        className={`product-sidebar-backdrop ${sidebarOpen ? "visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
        type="button"
      />
      <aside
        className={`product-sidebar product-resizable-panel ${sidebarOpen ? "open" : ""}${
          conversationPanel.collapsed ? " collapsed" : ""
        }`}
        style={{ width: conversationPanel.collapsed ? 42 : conversationPanel.width }}
      >
        <button
          aria-label={conversationPanel.collapsed ? "展开会话列表" : "收起会话列表"}
          className="product-panel-collapse"
          onClick={conversationPanel.toggle}
          title={conversationPanel.collapsed ? "展开会话列表" : "收起会话列表"}
          type="button"
        >
          {conversationPanel.collapsed ? "›" : "‹"}
        </button>
        {conversationPanel.collapsed ? <span className="product-collapsed-label">会话</span> : null}
        <div className="product-panel-content product-sidebar-content">
          <header className="product-sidebar-brand">
            <div className="product-logo">A</div>
            <strong>AgentDock</strong>
          </header>
          <div className="product-sidebar-actions">
            <button
              className="product-new-chat"
              onClick={() => beginNewConversation()}
              type="button"
            >
              <span>＋</span> 新对话
            </button>
          </div>
          <nav className="product-conversation-list" aria-label="对话列表">
            <span className="product-sidebar-label">最近对话</span>
            {conversations.length === 0 ? (
              <div className="product-conversation-empty">还没有对话</div>
            ) : (
              conversations.map((conversation) => (
                <div
                  className={`product-conversation-row${
                    conversation.parentSessionId === undefined ? "" : " branch"
                  }${state.session?.sessionId === conversation.sessionId ? " active" : ""}`}
                  key={conversation.sessionId}
                >
                  <button
                    disabled={conversationLoading !== null || operation !== null}
                    onClick={() => void openConversation(conversation)}
                    type="button"
                  >
                    <strong>
                      {conversation.parentSessionId === undefined ? null : (
                        <span className="product-conversation-branch-mark">↳ </span>
                      )}
                      {conversation.title}
                    </strong>
                    <small>
                      {conversation.workspaceName} · {relativeTime(conversation.lastActiveAt)}
                    </small>
                  </button>
                  <button
                    aria-label={`删除对话 ${conversation.title}`}
                    className="product-delete-conversation"
                    disabled={conversationLoading !== null || operation !== null}
                    onClick={() => void deleteConversation(conversation)}
                    title="删除对话"
                    type="button"
                  >
                    ×
                  </button>
                </div>
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
        </div>
        {conversationPanel.collapsed ? null : (
          <div
            aria-label="调整会话列表宽度"
            className="product-panel-resizer"
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft")
                conversationPanel.setWidth(conversationPanel.width - 12);
              if (event.key === "ArrowRight")
                conversationPanel.setWidth(conversationPanel.width + 12);
            }}
            onPointerDown={conversationPanel.beginResize}
            role="separator"
            tabIndex={0}
          />
        )}
      </aside>

      <ConversationTreeNavigator
        loading={treeLoading}
        onNavigate={(sessionId, turnId) => void openConversationSession(sessionId, turnId)}
        onViewChange={setTreeView}
        scrollerRef={chatScrollerRef}
        tree={conversationTree}
        view={treeView}
      />

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
            <strong>{state.session?.title ?? "新对话"}</strong>
            {state.project ? (
              <span>
                /workspace · {state.project.name}
                {state.session?.sandboxRetention === "persistent" ? " · 持久沙箱" : ""}
              </span>
            ) : null}
            {state.session ? (
              <span className={state.connection.phase === "live" ? "online" : ""}>
                {state.connection.phase === "live" ? "已连接" : "连接中"}
              </span>
            ) : null}
          </div>
          <div className="product-topbar-actions">
            {state.connection.phase === "failed" ? (
              <button onClick={() => setReconnectGeneration((value) => value + 1)} type="button">
                重新连接
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
                void createConversation();
              }}
            >
              <header>
                <div>
                  <h2>新建对话</h2>
                  <p>每个对话都在你选择的 /workspace 目录中工作。</p>
                </div>
                <button
                  onClick={() => {
                    setWorkspacePanelOpen(false);
                    setPendingInitialPrompt(null);
                  }}
                  type="button"
                >
                  ×
                </button>
              </header>
              <label>
                <span>对话标题</span>
                <input
                  autoFocus
                  maxLength={256}
                  onChange={(event) => setNewConversationTitle(event.target.value)}
                  placeholder="例如：修复订单服务的并发问题"
                  required
                  value={newConversationTitle}
                />
              </label>
              <fieldset className="product-workspace-choice">
                <legend>Workspace</legend>
                {workspaces.length > 0 ? (
                  <label className="product-choice-card">
                    <input
                      checked={workspaceChoice === "existing"}
                      onChange={() => setWorkspaceChoice("existing")}
                      type="radio"
                    />
                    <span>
                      <strong>选择已有 Workspace</strong>
                      <small>继续使用已有文件、依赖和 Git 状态</small>
                    </span>
                  </label>
                ) : null}
                {workspaceChoice === "existing" && workspaces.length > 0 ? (
                  <div className="product-workspace-selection">
                    <label>
                      <span>目录</span>
                      <select
                        onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                        value={selectedWorkspaceId}
                      >
                        {workspaces.map((workspace) => (
                          <option key={workspace.workspaceId} value={workspace.workspaceId}>
                            {workspace.name}（{String(workspace.sessionCount)} 个对话）
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedWorkspace === undefined ? null : (
                      <div className="product-workspace-delete">
                        <button
                          className="product-danger-button"
                          disabled={
                            !canMutate || selectedWorkspace.sessionCount > 0 || operation !== null
                          }
                          onClick={() => void deleteWorkspace(selectedWorkspace)}
                          title={
                            selectedWorkspace.sessionCount > 0
                              ? "请先删除这个 Workspace 下的所有对话"
                              : undefined
                          }
                          type="button"
                        >
                          {operation === "deleting-workspace" ? "删除中…" : "删除 Workspace"}
                        </button>
                        {selectedWorkspace.sessionCount > 0 ? (
                          <small>请先删除这个 Workspace 下的所有对话。</small>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
                <label className="product-choice-card">
                  <input
                    checked={workspaceChoice === "new"}
                    onChange={() => setWorkspaceChoice("new")}
                    type="radio"
                  />
                  <span>
                    <strong>创建新 Workspace</strong>
                    <small>创建一个新的空 /workspace 目录</small>
                  </span>
                </label>
                {workspaceChoice === "new" ? (
                  <label>
                    <span>Workspace 名称</span>
                    <input
                      maxLength={256}
                      onChange={(event) => setNewWorkspaceName(event.target.value)}
                      placeholder="例如：order-service"
                      required
                      value={newWorkspaceName}
                    />
                  </label>
                ) : null}
              </fieldset>
              <fieldset className="product-workspace-choice">
                <legend>沙箱生命周期</legend>
                <label className="product-choice-card">
                  <input
                    checked={sandboxRetention === "ephemeral"}
                    onChange={() => setSandboxRetention("ephemeral")}
                    type="radio"
                  />
                  <span>
                    <strong>自动回收（推荐）</strong>
                    <small>代码任务结束后短暂保温，空闲 15 分钟或资源紧张时回收</small>
                  </span>
                </label>
                <label className="product-choice-card">
                  <input
                    checked={sandboxRetention === "persistent"}
                    onChange={() => setSandboxRetention("persistent")}
                    type="radio"
                  />
                  <span>
                    <strong>持续运行</strong>
                    <small>跨多轮保留进程和服务，直到删除对话或执行环境发生故障</small>
                  </span>
                </label>
                {sandboxRetention === "persistent" &&
                workspaceChoice === "existing" &&
                (workspaces.find((workspace) => workspace.workspaceId === selectedWorkspaceId)
                  ?.sessionCount ?? 0) > 0 ? (
                  <p className="product-choice-warning">
                    持久沙箱需要独占 Workspace；请选择没有现有对话的 Workspace，或创建新的
                    Workspace。
                  </p>
                ) : null}
              </fieldset>
              <footer>
                <button
                  onClick={() => {
                    setWorkspacePanelOpen(false);
                    setPendingInitialPrompt(null);
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="product-primary-button"
                  disabled={
                    operation !== null ||
                    (sandboxRetention === "persistent" &&
                      workspaceChoice === "existing" &&
                      (workspaces.find((workspace) => workspace.workspaceId === selectedWorkspaceId)
                        ?.sessionCount ?? 0) > 0)
                  }
                  type="submit"
                >
                  {operation === "creating" ? "创建中…" : "创建对话"}
                </button>
              </footer>
            </form>
          </div>
        ) : null}

        {forkTarget === null ? null : (
          <div className="product-modal-backdrop" role="presentation">
            <form
              className="product-workspace-modal product-fork-modal"
              onSubmit={(event) => {
                event.preventDefault();
                void createConversationFork();
              }}
            >
              <header>
                <div>
                  <h2>从此对话开始</h2>
                  <p>复制这里之前的 Pi 对话上下文并创建一条新分支。</p>
                </div>
                <button
                  onClick={() => {
                    setForkTarget(null);
                    setForkTitle("");
                  }}
                  type="button"
                >
                  ×
                </button>
              </header>
              <label>
                <span>分支名称（可选）</span>
                <input
                  autoFocus
                  maxLength={256}
                  onChange={(event) => setForkTitle(event.target.value)}
                  placeholder="例如：改用事件驱动方案"
                  value={forkTitle}
                />
              </label>
              <p className="product-fork-note">
                Workspace 继续使用当前目录；此操作只分叉对话上下文，不会把文件回退到历史状态。
                分支首次调用工具时会取得这个 Workspace
                的执行权；其他分支持久沙箱里的后台进程不会跨分支保留。
              </p>
              <footer>
                <button
                  onClick={() => {
                    setForkTarget(null);
                    setForkTitle("");
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="product-primary-button"
                  disabled={operation !== null}
                  type="submit"
                >
                  {operation === "forking" ? "创建中…" : "创建分支"}
                </button>
              </footer>
            </form>
          </div>
        )}

        {state.apiError ? (
          <div className="product-error-banner">
            <span>{state.apiError}</span>
            <button onClick={() => update({ type: "api.error.cleared" })} type="button">
              ×
            </button>
          </div>
        ) : null}

        <div className={`product-content ${inspectorOpen ? "with-inspector" : ""}`}>
          <section className="product-chat-scroll" ref={chatScrollerRef}>
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
                {state.turns.map((turn) => {
                  const target = forkTargets.get(turn.turnId);
                  return (
                    <ConversationTurn
                      canFork={
                        canMutate &&
                        operation === null &&
                        currentTurn === undefined &&
                        target !== undefined
                      }
                      key={turn.turnId}
                      {...(target === undefined
                        ? {}
                        : {
                            onFork: () => {
                              setForkTitle("");
                              setForkTarget(target);
                            },
                          })}
                      turn={turn}
                    />
                  );
                })}
                <div ref={transcriptEndRef} />
              </div>
            )}
          </section>
          {inspectorOpen ? (
            <WorkspaceInspector
              api={api}
              onClose={() => setInspectorOpen(false)}
              onError={(message) => update({ type: "api.error", message })}
              refreshSignal={inspectorRefreshSignal}
              sessionId={state.session?.sessionId ?? null}
              workspaceName={state.project?.name ?? null}
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
              <>
                <button
                  className="product-steer-button"
                  disabled={!prompt.trim() || operation !== null}
                  onClick={() => void steerTurn()}
                  title="将这条消息注入当前运行中的 Agent Loop"
                  type="button"
                >
                  引导
                </button>
                <button
                  className="product-stop-button"
                  onClick={() => void cancelTurn()}
                  title="停止"
                  type="button"
                >
                  ■
                </button>
              </>
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
          {steerNotice === null ? null : (
            <small className="product-steer-notice">{steerNotice}</small>
          )}
          <small>Agent 可能会出错，请检查重要的代码修改和测试结果。</small>
        </footer>
      </main>
    </div>
  );
}
