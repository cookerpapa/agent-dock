import type {
  DevelopmentEnvironmentAction,
  DevelopmentEnvironmentListResource,
  DevelopmentEnvironmentProfileKey,
  DevelopmentEnvironmentResource,
  WorkspaceSummaryResource,
} from "@pi-cloud/protocol";
import { SANDBOX_PREVIEW_PORTS } from "@pi-cloud/protocol";
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
  const [profiles, setProfiles] = useState<DevelopmentEnvironmentListResource["profiles"]>([]);
  const [profileKey, setProfileKey] = useState<DevelopmentEnvironmentProfileKey>("standard");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.workspaceId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [terminalEnvironmentId, setTerminalEnvironmentId] = useState<string | null>(null);
  const [previewPort, setPreviewPort] = useState("8000");
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
    setProfiles(listed.profiles);
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
      await api.createDevelopmentEnvironment(
        workspaceId,
        profileKey,
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

  return (
    <div className="development-environment-page">
      <header className="development-environment-header">
        <div>
          <span className="development-environment-eyebrow">PI CLOUD · COMPUTE</span>
          <h1>开发环境</h1>
          <p>申请仅你可见的 Cube KVM 开发机。后台进程在终端断开后继续运行，暂停时保留内存状态。</p>
        </div>
        <button onClick={onClose} type="button">
          返回对话
        </button>
      </header>

      <section className="development-environment-create">
        <div className="development-environment-create-title">
          <strong>创建开发机</strong>
          <span>选择计算规格与 Workspace。系统盘随 VM 生命周期，Workspace 数据独立持久化。</span>
        </div>
        <div className="development-environment-profiles" role="radiogroup" aria-label="开发机规格">
          {profiles.map((profile) => (
            <button
              aria-checked={profile.key === profileKey}
              className={profile.key === profileKey ? "active" : ""}
              disabled={!canMutate || busy !== null}
              key={profile.key}
              onClick={() => setProfileKey(profile.key)}
              role="radio"
              type="button"
            >
              <span>
                <strong>{profile.label}</strong>
                {profile.recommended ? <em>推荐</em> : null}
              </span>
              <b>{String(profile.cpuCount)} vCPU</b>
              <small>{String(profile.memoryMiB / 1024)} GiB 内存</small>
              <small>{String(profile.systemDiskGiB)} GiB 系统盘</small>
            </button>
          ))}
        </div>
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
                      第 {String(environment.generation)} 代 · {String(environment.cpuCount)} vCPU ·{" "}
                      {String(environment.memoryMiB / 1024)} GiB ·{" "}
                      {String(environment.systemDiskGiB)} GiB 系统盘
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
                      <label className="development-environment-preview-port">
                        端口
                        <select
                          aria-label={`${environment.workspaceName} 预览端口`}
                          onChange={(event) => setPreviewPort(event.target.value)}
                          value={previewPort}
                        >
                          {SANDBOX_PREVIEW_PORTS.map((port) => (
                            <option key={port} value={port}>
                              {port}
                            </option>
                          ))}
                        </select>
                      </label>
                      <a
                        className="development-environment-preview-link"
                        href={`/v1/development-environments/${encodeURIComponent(environment.environmentId)}/preview/${encodeURIComponent(previewPort)}/`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        打开服务 ↗
                      </a>
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
