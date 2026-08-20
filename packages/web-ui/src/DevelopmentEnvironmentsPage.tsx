import type {
  DevelopmentEnvironmentAction,
  DevelopmentEnvironmentResource,
  WorkspaceSummaryResource,
} from "@pi-cloud/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PiCloudApi, newIdempotencyKey } from "./api.ts";
import { errorMessage } from "./ui-errors.ts";
import { WorkspaceTerminal } from "./WorkspaceTerminal.tsx";

function stateLabel(state: DevelopmentEnvironmentResource["state"]): string {
  switch (state) {
    case "requested":
      return "等待启动";
    case "provisioning":
      return "正在创建";
    case "running":
      return "运行中";
    case "paused":
      return "已暂停";
    case "releasing":
      return "正在释放";
    case "released":
      return "已释放";
    case "failed":
      return "需要重启";
    default:
      return "状态未知";
  }
}

export function DevelopmentEnvironmentsPage({
  api,
  workspaces,
  canMutate,
  onClose,
}: {
  api: PiCloudApi;
  workspaces: readonly WorkspaceSummaryResource[];
  canMutate: boolean;
  onClose: () => void;
}) {
  const [environments, setEnvironments] = useState<readonly DevelopmentEnvironmentResource[]>([]);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.workspaceId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [terminalEnvironmentId, setTerminalEnvironmentId] = useState<string | null>(null);
  const liveWorkspaceIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) =>
            ["requested", "provisioning", "running", "paused", "releasing", "unknown"].includes(
              environment.state,
            ),
          )
          .map((environment) => environment.workspaceId),
      ),
    [environments],
  );
  const availableWorkspaces = workspaces.filter(
    (workspace) => !liveWorkspaceIds.has(workspace.workspaceId),
  );

  const refresh = useCallback(async () => {
    const listed = await api.listDevelopmentEnvironments();
    setEnvironments(listed.environments);
  }, [api]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice(errorMessage(error)));
  }, [refresh]);

  useEffect(() => {
    if (
      !environments.some((environment) =>
        ["requested", "provisioning", "releasing", "unknown"].includes(environment.state),
      )
    ) {
      return;
    }
    const timer = setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => clearInterval(timer);
  }, [environments, refresh]);

  useEffect(() => {
    if (availableWorkspaces.some((workspace) => workspace.workspaceId === workspaceId)) return;
    setWorkspaceId(availableWorkspaces[0]?.workspaceId ?? "");
  }, [availableWorkspaces, workspaceId]);

  const act = async (
    environment: DevelopmentEnvironmentResource,
    action: DevelopmentEnvironmentAction,
  ): Promise<void> => {
    setBusy(environment.environmentId);
    setNotice(null);
    if (action !== "resume") setTerminalEnvironmentId(null);
    try {
      await api.developmentEnvironmentAction(
        environment.environmentId,
        action,
        newIdempotencyKey("environment"),
      );
      await refresh();
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const create = async (): Promise<void> => {
    if (workspaceId === "") return;
    setBusy("create");
    setNotice(null);
    try {
      await api.createDevelopmentEnvironment(workspaceId, newIdempotencyKey("environment"));
      await refresh();
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="development-environment-page">
      <header className="development-environment-header">
        <div>
          <span className="product-sidebar-label">独占计算</span>
          <h1>开发环境</h1>
          <p>为一个 Workspace 申请独占 Cube KVM。环境仅你可见，暂停时保留进程和内存。</p>
        </div>
        <button onClick={onClose} type="button">
          返回对话
        </button>
      </header>

      <section className="development-environment-create">
        <label>
          <span>Workspace</span>
          <select
            disabled={!canMutate || busy !== null || availableWorkspaces.length === 0}
            onChange={(event) => setWorkspaceId(event.target.value)}
            value={workspaceId}
          >
            {availableWorkspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="product-primary-button"
          disabled={!canMutate || busy !== null || workspaceId === ""}
          onClick={() => void create()}
          type="button"
        >
          {busy === "create" ? "正在申请…" : "申请独占环境"}
        </button>
        {availableWorkspaces.length === 0 ? (
          <small>创建一个 Workspace，或先释放已有环境。</small>
        ) : null}
      </section>

      {notice === null ? null : <div className="development-environment-notice">{notice}</div>}

      <section className="development-environment-list">
        {environments.length === 0 ? (
          <div className="development-environment-empty">还没有申请开发环境。</div>
        ) : (
          environments.map((environment) => {
            const selected = terminalEnvironmentId === environment.environmentId;
            return (
              <article
                className={`development-environment-card ${environment.state}`}
                key={environment.environmentId}
              >
                <header>
                  <div>
                    <h2>{environment.workspaceName}</h2>
                    <span>
                      第 {String(environment.generation)} 代 · {stateLabel(environment.state)}
                    </span>
                  </div>
                  <span className="development-environment-state">
                    {stateLabel(environment.state)}
                  </span>
                </header>
                {environment.failureCode === undefined ? null : (
                  <p className="development-environment-failure">{environment.failureCode}</p>
                )}
                <div className="development-environment-actions">
                  {environment.state === "running" ? (
                    <>
                      <button
                        disabled={busy !== null}
                        onClick={() =>
                          setTerminalEnvironmentId(selected ? null : environment.environmentId)
                        }
                        type="button"
                      >
                        {selected ? "收起终端" : "打开终端"}
                      </button>
                      <button
                        disabled={busy !== null}
                        onClick={() => void act(environment, "pause")}
                        type="button"
                      >
                        暂停
                      </button>
                    </>
                  ) : null}
                  {environment.state === "paused" ? (
                    <button
                      disabled={busy !== null}
                      onClick={() => void act(environment, "resume")}
                      type="button"
                    >
                      恢复
                    </button>
                  ) : null}
                  {environment.state === "requested" || environment.state === "failed" ? (
                    <button
                      disabled={busy !== null}
                      onClick={() => void act(environment, "start")}
                      type="button"
                    >
                      启动
                    </button>
                  ) : null}
                  {["requested", "running", "paused", "failed", "unknown"].includes(
                    environment.state,
                  ) ? (
                    <button
                      className="product-danger-button"
                      disabled={busy !== null}
                      onClick={() => void act(environment, "release")}
                      type="button"
                    >
                      释放
                    </button>
                  ) : null}
                </div>
                {selected && environment.state === "running" ? (
                  <WorkspaceTerminal
                    environmentId={environment.environmentId}
                    onError={(message) => setNotice(message)}
                  />
                ) : null}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
