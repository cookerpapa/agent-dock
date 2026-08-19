import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  ConversationTreeBranchResource,
  ConversationTreeResource,
  ConversationTreeView,
  DelegatedSessionSummaryResource,
} from "@pi-cloud/protocol";
import { selectActiveTurn } from "./active-turn-selection.ts";
import { useResizablePanel } from "./use-resizable-panel.ts";

const PROGRAMMATIC_SCROLL_GUARD_MS = 1_000;

function compact(value: string, maximum = 76): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text || "（空消息）";
}

function turnElements(scroller: HTMLElement): ReadonlyMap<string, HTMLElement> {
  const elements = new Map<string, HTMLElement>();
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-conversation-turn-id]")) {
    const turnId = element.dataset.conversationTurnId;
    if (turnId !== undefined) elements.set(turnId, element);
  }
  return elements;
}

function branchChildren(tree: ConversationTreeResource) {
  const children = new Map<string, ConversationTreeBranchResource[]>();
  for (const branch of tree.branches) {
    if (branch.parentSessionId === null || branch.forkedFromEntryId === null) continue;
    const key = `${branch.parentSessionId}:${branch.forkedFromEntryId}`;
    const siblings = children.get(key) ?? [];
    siblings.push(branch);
    children.set(key, siblings);
  }
  return children;
}

function delegatedChildren(tree: ConversationTreeResource) {
  const children = new Map<string, DelegatedSessionSummaryResource[]>();
  for (const delegated of tree.delegatedSessions) {
    const key = `${delegated.parentSessionId}:${delegated.parentTurnId}`;
    const siblings = children.get(key) ?? [];
    siblings.push(delegated);
    children.set(key, siblings);
  }
  return children;
}

function contextLabel(mode: DelegatedSessionSummaryResource["contextMode"]): string {
  return mode === "fork" ? "继承上下文" : "独立上下文";
}

function workspaceLabel(mode: DelegatedSessionSummaryResource["workspaceMode"]): string {
  if (mode === "shared_serialized") return "共享工作区";
  if (mode === "isolated") return "隔离工作区";
  return "无工具";
}

function TreeBranch({
  branch,
  children,
  delegations,
  depth,
  activeTurnId,
  currentSessionId,
  navigate,
}: {
  branch: ConversationTreeBranchResource;
  children: ReadonlyMap<string, readonly ConversationTreeBranchResource[]>;
  delegations: ReadonlyMap<string, readonly DelegatedSessionSummaryResource[]>;
  depth: number;
  activeTurnId: string | null;
  currentSessionId: string;
  navigate: (sessionId: string, turnId?: string) => void;
}) {
  return (
    <div className="product-tree-branch" style={{ "--tree-depth": depth } as React.CSSProperties}>
      {branch.parentSessionId === null ? null : (
        <button
          className={`product-tree-branch-label${branch.current ? " current" : ""}`}
          onClick={() => {
            const first = branch.entries[0];
            if (first !== undefined) navigate(branch.sessionId, first.turnId);
          }}
          title={branch.title}
          type="button"
        >
          <span>↳</span>
          <strong>{branch.title}</strong>
        </button>
      )}
      {branch.entries.map((entry) => {
        const nested = children.get(`${branch.sessionId}:${entry.entryId}`) ?? [];
        const delegated = entry.finalAssistant
          ? (delegations.get(`${branch.sessionId}:${entry.turnId}`) ?? [])
          : [];
        return (
          <div className="product-tree-entry-wrap" key={`${branch.sessionId}:${entry.entryId}`}>
            <button
              aria-current={activeTurnId === entry.turnId ? "true" : undefined}
              className={`product-tree-entry product-tree-${entry.role}${
                activeTurnId === entry.turnId ? " active" : ""
              }`}
              onClick={() => navigate(branch.sessionId, entry.turnId)}
              title={compact(entry.text, 240)}
              type="button"
            >
              <span className="product-tree-connector" aria-hidden="true">
                {entry.role === "user" ? "U" : "A"}
              </span>
              <span>{compact(entry.text)}</span>
            </button>
            {nested.map((child) => (
              <TreeBranch
                activeTurnId={activeTurnId}
                branch={child}
                children={children}
                currentSessionId={currentSessionId}
                delegations={delegations}
                depth={depth + 1}
                key={child.sessionId}
                navigate={navigate}
              />
            ))}
            {delegated.map((child) => (
              <button
                className={`product-tree-delegated ${child.contextMode}${
                  currentSessionId === child.sessionId ? " current" : ""
                }`}
                key={child.executionId}
                onClick={() => navigate(child.sessionId)}
                title={`${child.agentName} · ${contextLabel(child.contextMode)} · ${workspaceLabel(child.workspaceMode)}`}
                type="button"
              >
                <span aria-hidden="true">{child.contextMode === "fork" ? "↳" : "⋯"}</span>
                <span>
                  <strong>{child.agentName}</strong>
                  <small>
                    {contextLabel(child.contextMode)} · {workspaceLabel(child.workspaceMode)} ·{" "}
                    {child.state}
                  </small>
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function ConversationTreeNavigator({
  tree,
  view,
  loading,
  scrollerRef,
  onViewChange,
  onNavigate,
}: {
  tree: ConversationTreeResource | null;
  view: ConversationTreeView;
  loading: boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  onViewChange: (view: ConversationTreeView) => void;
  onNavigate: (sessionId: string, turnId?: string) => void;
}) {
  const panel = useResizablePanel({
    storageKey: "pi-cloud:conversation-tree",
    initialWidth: 300,
    minimumWidth: 220,
    maximumWidth: 520,
  });
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const jumpTargetRef = useRef<string | null>(null);
  const jumpReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentEntries = useMemo(() => {
    if (tree === null) return [];
    const byId = new Map(tree.branches.map((branch) => [branch.sessionId, branch] as const));
    const lineage = new Set<string>();
    let cursor: string | null = tree.currentSessionId;
    while (cursor !== null) {
      lineage.add(cursor);
      cursor = byId.get(cursor)?.parentSessionId ?? null;
    }
    return tree.branches
      .filter((branch) => lineage.has(branch.sessionId))
      .flatMap((branch) => branch.entries);
  }, [tree]);
  const currentTurnIds = useMemo(
    () => [...new Set(currentEntries.map((entry) => entry.turnId))],
    [currentEntries],
  );
  const identity = currentTurnIds.join("\u0000");

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || currentTurnIds.length === 0) return;
    const updateActive = (): void => {
      if (jumpTargetRef.current !== null) return;
      const bounds = scroller.getBoundingClientRect();
      const elements = turnElements(scroller);
      setActiveTurnId(
        selectActiveTurn({
          anchors: currentTurnIds.flatMap((turnId) => {
            const element = elements.get(turnId);
            return element === undefined
              ? []
              : [{ turnId, top: element.getBoundingClientRect().top }];
          }),
          clientHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
          scrollerTop: bounds.top,
        }),
      );
    };
    scroller.addEventListener("scroll", updateActive, { passive: true });
    updateActive();
    return () => scroller.removeEventListener("scroll", updateActive);
  }, [identity, scrollerRef]);

  useEffect(
    () => () => {
      if (jumpReleaseTimerRef.current !== null) clearTimeout(jumpReleaseTimerRef.current);
    },
    [],
  );

  const navigate = (sessionId: string, turnId?: string): void => {
    if (turnId === undefined) {
      onNavigate(sessionId);
      return;
    }
    const scroller = scrollerRef.current;
    const target = scroller === null ? undefined : turnElements(scroller).get(turnId);
    if (target === undefined) {
      onNavigate(sessionId, turnId);
      return;
    }
    jumpTargetRef.current = turnId;
    setActiveTurnId(turnId);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (jumpReleaseTimerRef.current !== null) clearTimeout(jumpReleaseTimerRef.current);
    jumpReleaseTimerRef.current = setTimeout(() => {
      jumpTargetRef.current = null;
      jumpReleaseTimerRef.current = null;
    }, PROGRAMMATIC_SCROLL_GUARD_MS);
  };

  const root = tree?.branches.find((branch) => branch.parentSessionId === null) ?? null;
  const children = tree === null ? new Map() : branchChildren(tree);
  const delegations = tree === null ? new Map() : delegatedChildren(tree);
  return (
    <aside
      className={`product-tree-panel product-resizable-panel${panel.collapsed ? " collapsed" : ""}`}
      style={{ width: panel.collapsed ? 42 : panel.width }}
    >
      <button
        aria-label={panel.collapsed ? "展开对话导航" : "收起对话导航"}
        className="product-panel-collapse"
        onClick={panel.toggle}
        title={panel.collapsed ? "展开对话导航" : "收起对话导航"}
        type="button"
      >
        {panel.collapsed ? "›" : "‹"}
      </button>
      {panel.collapsed ? <span className="product-collapsed-label">导航</span> : null}
      <div className="product-panel-content">
        <header className="product-tree-header">
          <div>
            <strong>对话导航</strong>
            <span>{tree === null ? "选择一个对话" : `${String(tree.branches.length)} 条分支`}</span>
          </div>
          <div className="product-tree-view-switch" role="group" aria-label="树视图">
            <button
              className={view === "focus" ? "active" : ""}
              onClick={() => onViewChange("focus")}
              type="button"
            >
              当前分支
            </button>
            <button
              className={view === "full" ? "active" : ""}
              onClick={() => onViewChange("full")}
              type="button"
            >
              整棵树
            </button>
          </div>
        </header>
        <nav className="product-tree-nav" aria-label="Pi 会话树">
          {loading ? (
            <div className="product-tree-empty">正在读取会话树…</div>
          ) : root === null ? (
            <div className="product-tree-empty">发送第一条消息后，这里会显示对话路径。</div>
          ) : (
            <TreeBranch
              activeTurnId={activeTurnId}
              branch={root}
              children={children}
              currentSessionId={tree!.currentSessionId}
              delegations={delegations}
              depth={0}
              navigate={navigate}
            />
          )}
        </nav>
      </div>
      {panel.collapsed ? null : (
        <div
          aria-label="调整对话导航宽度"
          className="product-panel-resizer"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") panel.setWidth(panel.width - 12);
            if (event.key === "ArrowRight") panel.setWidth(panel.width + 12);
          }}
          onPointerDown={panel.beginResize}
          role="separator"
          tabIndex={0}
        />
      )}
    </aside>
  );
}
