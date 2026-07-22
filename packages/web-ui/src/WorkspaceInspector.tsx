import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GitHubPullRequestDeliveryResource,
  ModelGovernanceResource,
  OperationalAuditLogResource,
  OperationalInsightsResource,
  ProjectEnvironmentHistoryResource,
  RunListResource,
  RunUsageResource,
  SessionContextResource,
  TenantApiRole,
  TestResultListResource,
  UsageSummaryResource,
  WorkspaceArtifactResource,
  WorkspaceFileResource,
  WorkspaceSourceResource,
  WorkspaceVersionCompareResource,
  WorkspaceVersionListResource,
  WorkspaceVersionResource,
} from "@agent-dock/protocol";
import { parseEnvironmentRecipe } from "@agent-dock/protocol";
import { AgentDockApi, AgentDockApiError, newIdempotencyKey } from "./api.ts";

type InspectorTab = "workspace" | "environment" | "runs" | "tests" | "usage" | "activity";

type WorkspaceInspectorProps = {
  api: AgentDockApi;
  sessionId: string | null;
  projectId: string | null;
  role: TenantApiRole | null;
  busy: boolean;
  refreshSignal: number;
  source: WorkspaceSourceResource | null;
  onClose: () => void;
  onError: (message: string) => void;
  onForked: (sessionId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  onSessionChanged: () => Promise<void>;
};

type FilePreview = {
  path: string;
  text: string;
  binary: boolean;
  truncated: boolean;
};

type ArtifactPreview = {
  title: string;
  text: string;
  truncated: boolean;
};

const TERMINAL_RETRY_STATES = new Set(["failed", "cancelled", "timed_out", "superseded"]);
const MAX_PREVIEW_BYTES = 256 * 1_024;

function failureMessage(error: unknown): string {
  if (error instanceof AgentDockApiError) return `${error.code}: ${error.message}`;
  return "Inspector request failed before it was confirmed.";
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function bytesLabel(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function durationLabel(value: number | undefined): string {
  if (value === undefined) return "pending";
  if (value < 1_000) return `${String(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

function costLabel(value: number): string {
  return `$${(value / 1_000_000).toFixed(4)}`;
}

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown" : date.toLocaleString();
}

function decodePreview(bytes: Uint8Array, path: string): FilePreview {
  const limited = bytes.subarray(0, MAX_PREVIEW_BYTES);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(limited);
    if (text.includes("\u0000")) throw new TypeError("binary");
    return { path, text, binary: false, truncated: bytes.byteLength > limited.byteLength };
  } catch {
    return {
      path,
      text: `Binary preview is disabled (${bytesLabel(bytes.byteLength)}).`,
      binary: true,
      truncated: false,
    };
  }
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function artifactName(artifact: WorkspaceArtifactResource): string {
  const candidate = artifact.fileName ?? `${artifact.kind}-${shortId(artifact.artifactId)}`;
  const safe = candidate.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return safe.length === 0 ? `artifact-${shortId(artifact.artifactId)}` : safe;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyPanel({ children }: { children: string }) {
  return <div className="inspector-empty">{children}</div>;
}

export function WorkspaceInspector({
  api,
  sessionId,
  projectId,
  role,
  busy,
  refreshSignal,
  source,
  onClose,
  onError,
  onForked,
  onRetry,
  onSessionChanged,
}: WorkspaceInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("workspace");
  const [loading, setLoading] = useState(false);
  const [mutation, setMutation] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunListResource | null>(null);
  const [versions, setVersions] = useState<WorkspaceVersionListResource | null>(null);
  const [context, setContext] = useState<SessionContextResource | null>(null);
  const [usage, setUsage] = useState<UsageSummaryResource | null>(null);
  const [governance, setGovernance] = useState<ModelGovernanceResource | null>(null);
  const [operations, setOperations] = useState<OperationalInsightsResource | null>(null);
  const [audit, setAudit] = useState<OperationalAuditLogResource | null>(null);
  const [environments, setEnvironments] = useState<ProjectEnvironmentHistoryResource | null>(null);
  const [selectedEnvironmentVersionId, setSelectedEnvironmentVersionId] = useState<string | null>(
    null,
  );
  const [environmentRecipeText, setEnvironmentRecipeText] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runUsage, setRunUsage] = useState<RunUsageResource | null>(null);
  const [testResults, setTestResults] = useState<TestResultListResource | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [files, setFiles] = useState<readonly WorkspaceFileResource[]>([]);
  const [comparison, setComparison] = useState<WorkspaceVersionCompareResource | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null);
  const [pullRequestBaseBranch, setPullRequestBaseBranch] = useState("main");
  const [pullRequestHeadBranch, setPullRequestHeadBranch] = useState("");
  const [pullRequestTitle, setPullRequestTitle] = useState("AgentDock workspace changes");
  const [pullRequestBody, setPullRequestBody] = useState(
    "Generated from a fenced AgentDock Run and immutable Workspace checkpoint.",
  );
  const [pullRequestDelivery, setPullRequestDelivery] =
    useState<GitHubPullRequestDeliveryResource | null>(null);

  const selectedVersion = useMemo(
    () => versions?.versions.find((version) => version.versionId === selectedVersionId) ?? null,
    [selectedVersionId, versions],
  );
  const selectedRun = useMemo(
    () => runs?.runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const selectedEnvironment = useMemo(
    () =>
      environments?.versions.find(
        (environment) => environment.environmentVersionId === selectedEnvironmentVersionId,
      ) ?? null,
    [environments, selectedEnvironmentVersionId],
  );

  const refresh = useCallback(async () => {
    if (sessionId === null) return;
    setLoading(true);
    try {
      const [
        runList,
        versionList,
        sessionContext,
        tenantUsage,
        modelGovernance,
        environmentHistory,
        ownerData,
      ] = await Promise.all([
        api.listRuns(sessionId),
        api.listWorkspaceVersions(sessionId),
        api.getSessionContext(sessionId),
        api.getUsage(),
        api.getModelGovernance(),
        projectId === null ? Promise.resolve(null) : api.getProjectEnvironments(projectId),
        role === "owner"
          ? Promise.all([api.getOperationalInsights(), api.getOperationalAudit()])
          : Promise.resolve(null),
      ]);
      setRuns(runList);
      setVersions(versionList);
      setContext(sessionContext);
      setUsage(tenantUsage);
      setGovernance(modelGovernance);
      setEnvironments(environmentHistory);
      setOperations(ownerData?.[0] ?? null);
      setAudit(ownerData?.[1] ?? null);
      setSelectedRunId((current) =>
        current !== null && runList.runs.some((run) => run.runId === current)
          ? current
          : (runList.runs[0]?.runId ?? null),
      );
      setSelectedVersionId((current) =>
        current !== null && versionList.versions.some((version) => version.versionId === current)
          ? current
          : (versionList.currentVersionId ?? versionList.versions[0]?.versionId ?? null),
      );
      setSelectedEnvironmentVersionId((current) =>
        current !== null &&
        environmentHistory?.versions.some(
          (environment) => environment.environmentVersionId === current,
        )
          ? current
          : (environmentHistory?.activeEnvironmentVersionId ?? null),
      );
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setLoading(false);
    }
  }, [api, onError, projectId, role, sessionId]);

  useEffect(() => {
    setRuns(null);
    setVersions(null);
    setContext(null);
    setUsage(null);
    setGovernance(null);
    setOperations(null);
    setAudit(null);
    setEnvironments(null);
    setSelectedEnvironmentVersionId(null);
    setEnvironmentRecipeText("");
    setSelectedRunId(null);
    setSelectedVersionId(null);
    setFiles([]);
    setComparison(null);
    setFilePreview(null);
    setArtifactPreview(null);
    if (sessionId !== null) void refresh();
  }, [refresh, refreshSignal, sessionId]);

  useEffect(() => {
    setEnvironmentRecipeText(
      selectedEnvironment === null ? "" : JSON.stringify(selectedEnvironment.recipe, null, 2),
    );
  }, [selectedEnvironment]);

  useEffect(() => {
    setPullRequestDelivery(null);
    setPullRequestHeadBranch(
      sessionId === null ? "" : `agent-dock/${shortId(sessionId)}-${Date.now().toString(36)}`,
    );
  }, [sessionId]);

  useEffect(() => {
    if (selectedRunId === null) {
      setRunUsage(null);
      setTestResults(null);
      return;
    }
    let cancelled = false;
    void Promise.all([api.getRunUsage(selectedRunId), api.listRunTestResults(selectedRunId)])
      .then(([nextUsage, nextTests]) => {
        if (cancelled) return;
        setRunUsage(nextUsage);
        setTestResults(nextTests);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(failureMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api, onError, selectedRunId]);

  useEffect(() => {
    if (selectedVersion === null) {
      setFiles([]);
      setComparison(null);
      setFilePreview(null);
      return;
    }
    let cancelled = false;
    const baseVersionId = selectedVersion.parentVersionId ?? selectedVersion.sourceVersionId;
    void Promise.all([
      api.listWorkspaceFiles(selectedVersion.versionId),
      baseVersionId === undefined
        ? Promise.resolve(null)
        : api.compareWorkspaceVersions(baseVersionId, selectedVersion.versionId),
    ])
      .then(([fileList, nextComparison]) => {
        if (cancelled) return;
        setFiles(fileList.files);
        setComparison(nextComparison);
        setFilePreview(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(failureMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api, onError, selectedVersion]);

  async function previewFile(file: WorkspaceFileResource): Promise<void> {
    if (selectedVersionId === null) return;
    try {
      const loaded = await api.readWorkspaceFile(selectedVersionId, file.path);
      setArtifactPreview(null);
      setFilePreview(decodePreview(loaded.bytes, file.path));
    } catch (error: unknown) {
      onError(failureMessage(error));
    }
  }

  async function previewArtifact(artifact: WorkspaceArtifactResource): Promise<void> {
    try {
      const loaded = await api.readArtifact(artifact.artifactId);
      const preview = decodePreview(loaded.bytes, artifactName(artifact));
      setFilePreview(null);
      setArtifactPreview({
        title: preview.path,
        text: preview.text,
        truncated: preview.truncated,
      });
    } catch (error: unknown) {
      onError(failureMessage(error));
    }
  }

  async function downloadArtifact(artifact: WorkspaceArtifactResource): Promise<void> {
    try {
      const loaded = await api.readArtifact(artifact.artifactId);
      const url = URL.createObjectURL(
        new Blob([blobPart(loaded.bytes)], { type: loaded.contentType }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifactName(artifact);
      anchor.rel = "noopener";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error: unknown) {
      onError(failureMessage(error));
    }
  }

  async function forkSelectedVersion(): Promise<void> {
    if (sessionId === null || selectedVersionId === null || mutation !== null) return;
    setMutation("forking");
    try {
      const result = await api.forkSession(sessionId, selectedVersionId, newIdempotencyKey("fork"));
      await onSessionChanged();
      if (result.forkedSessionId !== undefined) await onForked(result.forkedSessionId);
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  async function rollbackSelectedVersion(): Promise<void> {
    if (
      sessionId === null ||
      selectedVersionId === null ||
      versions?.currentVersionId === undefined ||
      mutation !== null ||
      !globalThis.confirm("Restore this immutable Workspace version for the next turn?")
    ) {
      return;
    }
    setMutation("rolling back");
    try {
      await api.rollbackWorkspace(
        sessionId,
        selectedVersionId,
        versions.currentVersionId,
        newIdempotencyKey("rollback"),
      );
      await Promise.all([refresh(), onSessionChanged()]);
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  async function changeArchiveState(): Promise<void> {
    if (sessionId === null || versions === null || mutation !== null) return;
    const next = !versions.archived;
    if (!globalThis.confirm(`${next ? "Archive" : "Unarchive"} this Session?`)) return;
    setMutation(next ? "archiving" : "unarchiving");
    try {
      await api.archiveSession(sessionId, next, newIdempotencyKey("archive"));
      await Promise.all([refresh(), onSessionChanged()]);
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  async function retrySelectedRun(): Promise<void> {
    if (selectedRunId === null || mutation !== null) return;
    setMutation("retrying");
    try {
      await onRetry(selectedRunId);
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  async function createEnvironmentVersion(): Promise<void> {
    if (projectId === null || mutation !== null || role !== "owner") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(environmentRecipeText) as unknown;
    } catch {
      onError("Environment recipe is not valid JSON.");
      return;
    }
    let recipe;
    try {
      recipe = parseEnvironmentRecipe(parsed);
    } catch {
      onError("Environment recipe does not match the bounded AgentDock schema.");
      return;
    }
    setMutation("creating environment candidate");
    try {
      const history = await api.createProjectEnvironment(
        projectId,
        recipe,
        newIdempotencyKey("environment-create"),
      );
      setEnvironments(history);
      const candidate = history.versions.find((environment) => !environment.active);
      setSelectedEnvironmentVersionId(candidate?.environmentVersionId ?? null);
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  async function validateEnvironmentVersion(): Promise<void> {
    if (
      sessionId === null ||
      selectedEnvironmentVersionId === null ||
      mutation !== null ||
      role !== "owner"
    ) {
      return;
    }
    setMutation("queuing environment validation");
    try {
      await api.validateProjectEnvironment(
        sessionId,
        selectedEnvironmentVersionId,
        newIdempotencyKey("environment-validate"),
      );
      await onSessionChanged();
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  async function activateEnvironmentVersion(): Promise<void> {
    if (
      projectId === null ||
      environments === null ||
      selectedEnvironmentVersionId === null ||
      mutation !== null ||
      role !== "owner" ||
      !globalThis.confirm("Activate this validated environment for future Runs?")
    ) {
      return;
    }
    setMutation("activating environment");
    try {
      const history = await api.activateProjectEnvironment(
        projectId,
        selectedEnvironmentVersionId,
        environments.activeEnvironmentVersionId,
        newIdempotencyKey("environment-activate"),
      );
      setEnvironments(history);
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  async function deliverPullRequest(): Promise<void> {
    if (
      source?.kind !== "github_app" ||
      selectedVersionId === null ||
      mutation !== null ||
      pullRequestBaseBranch.trim() === "" ||
      pullRequestHeadBranch.trim() === "" ||
      pullRequestTitle.trim() === ""
    ) {
      return;
    }
    setMutation("delivering pull request");
    try {
      const delivery = await api.createGitHubPullRequest(
        selectedVersionId,
        {
          repositoryId: source.repositoryId,
          baseBranch: pullRequestBaseBranch.trim(),
          baseCommitSha: source.commitSha,
          headBranch: pullRequestHeadBranch.trim(),
          title: pullRequestTitle.trim(),
          body: pullRequestBody,
        },
        newIdempotencyKey("pr"),
      );
      setPullRequestDelivery(delivery);
      await refresh();
    } catch (error: unknown) {
      onError(failureMessage(error));
    } finally {
      setMutation(null);
    }
  }

  return (
    <aside className="workspace-inspector" aria-label="Session inspector">
      <header className="inspector-header">
        <div>
          <strong>Session inspector</strong>
          <span>{sessionId === null ? "no session" : shortId(sessionId)}</span>
        </div>
        <button
          disabled={sessionId === null || loading}
          onClick={() => void refresh()}
          type="button"
        >
          {loading ? "loading…" : "refresh"}
        </button>
        <button aria-label="Close session inspector" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <nav className="inspector-tabs" aria-label="Inspector sections">
        {(["workspace", "environment", "runs", "tests", "usage", "activity"] as const).map(
          (value) => (
            <button
              aria-selected={tab === value}
              className={tab === value ? "active" : ""}
              key={value}
              onClick={() => setTab(value)}
              role="tab"
              type="button"
            >
              {value}
            </button>
          ),
        )}
      </nav>
      <div className="inspector-scroll">
        {sessionId === null ? <EmptyPanel>Select a durable Session first.</EmptyPanel> : null}

        {sessionId !== null && tab === "workspace" ? (
          <section className="inspector-panel">
            <div className="inspector-section-heading">
              <div>
                <strong>Versioned workspace</strong>
                <span>
                  {versions?.archived ? "archived" : "active"} · current v
                  {versions?.versions.find(
                    (version) => version.versionId === versions.currentVersionId,
                  )?.versionNumber ?? "—"}
                </span>
              </div>
              <div className="inspector-actions">
                <button
                  disabled={!role || role === "viewer" || busy || selectedVersionId === null}
                  onClick={() => void forkSelectedVersion()}
                  type="button"
                >
                  fork
                </button>
                <button
                  disabled={
                    !role ||
                    role === "viewer" ||
                    busy ||
                    selectedVersionId === null ||
                    selectedVersionId === versions?.currentVersionId
                  }
                  onClick={() => void rollbackSelectedVersion()}
                  type="button"
                >
                  rollback
                </button>
                <button
                  disabled={!role || role === "viewer" || busy || versions === null}
                  onClick={() => void changeArchiveState()}
                  type="button"
                >
                  {versions?.archived ? "unarchive" : "archive"}
                </button>
              </div>
            </div>
            {source ? (
              <div className="source-card">
                <span>project source</span>
                <strong>
                  {source.kind === "empty"
                    ? "empty workspace"
                    : source.kind === "sample_java"
                      ? "sample/java-repair"
                      : source.kind === "github_public"
                        ? source.repository
                        : source.kind === "github_app"
                          ? `${source.repository} · installation ${String(source.installationId)}`
                          : `${String(source.repositories.length)} repositories · ${source.repositories
                              .map((repository) => repository.root)
                              .join(", ")}`}
                </strong>
                <small>
                  {source.kind === "empty"
                    ? "clean git baseline"
                    : source.kind === "sample_java"
                      ? "built-in immutable seed"
                      : source.kind === "repository_set"
                        ? `${source.status} · exact commits under disjoint roots`
                        : `${shortId(source.commitSha)} · ${source.status}`}
                </small>
                {source.kind === "repository_set" ? (
                  <ul className="source-repository-set">
                    {source.repositories.map((repository) => (
                      <li key={repository.root}>
                        <code>{repository.root}/</code>
                        <span>
                          {repository.repository}@{shortId(repository.commitSha)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {mutation ? <div className="inspector-progress">{mutation}…</div> : null}
            <label className="inspector-field">
              <span>checkpoint</span>
              <select
                onChange={(event) => setSelectedVersionId(event.target.value)}
                value={selectedVersionId ?? ""}
              >
                {versions?.versions.map((version) => (
                  <option key={version.versionId} value={version.versionId}>
                    v{String(version.versionNumber)} · {version.origin} ·{" "}
                    {shortId(version.revision)}
                  </option>
                ))}
              </select>
            </label>
            {selectedVersion ? (
              <div className="inspector-metrics compact">
                <Metric label="files" value={String(selectedVersion.fileCount)} />
                <Metric label="origin" value={selectedVersion.origin} />
                <Metric label="revision" value={shortId(selectedVersion.revision)} />
              </div>
            ) : null}
            <div className="inspector-subheading">structured diff</div>
            {comparison === null ? (
              <EmptyPanel>This is the first version; no parent diff exists.</EmptyPanel>
            ) : (
              <>
                <div className="diff-summary-grid">
                  <span className="change-added">+{String(comparison.summary.added)}</span>
                  <span className="change-modified">~{String(comparison.summary.modified)}</span>
                  <span className="change-deleted">−{String(comparison.summary.deleted)}</span>
                  <span>{String(comparison.summary.modeChanged)} mode</span>
                </div>
                <div className="changed-file-list">
                  {comparison.files.length === 0 ? (
                    <EmptyPanel>No content or mode changes.</EmptyPanel>
                  ) : (
                    comparison.files.map((file) => (
                      <button
                        className={`change-${file.change}`}
                        key={`${file.change}:${file.path}`}
                        onClick={() => {
                          const target = files.find((candidate) => candidate.path === file.path);
                          if (target !== undefined) void previewFile(target);
                        }}
                        type="button"
                      >
                        <span>{file.change.replace("_", " ")}</span>
                        <code>{file.path}</code>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
            <div className="inspector-subheading">files</div>
            <div className="workspace-file-list">
              {files.length === 0 ? (
                <EmptyPanel>No files in this checkpoint.</EmptyPanel>
              ) : (
                files.map((file) => (
                  <button key={file.path} onClick={() => void previewFile(file)} type="button">
                    <code>{file.path}</code>
                    <span>{bytesLabel(file.sizeBytes)}</span>
                  </button>
                ))
              )}
            </div>
            <div className="inspector-subheading">artifacts</div>
            <div className="artifact-list">
              {selectedVersion?.artifacts.map((artifact) => (
                <div key={artifact.artifactId}>
                  <span>
                    <strong>{artifact.kind}</strong>
                    <small>
                      {artifact.fileName ?? shortId(artifact.artifactId)} ·{" "}
                      {bytesLabel(artifact.sizeBytes)}
                    </small>
                  </span>
                  <button onClick={() => void previewArtifact(artifact)} type="button">
                    preview
                  </button>
                  <button onClick={() => void downloadArtifact(artifact)} type="button">
                    save
                  </button>
                </div>
              )) ?? <EmptyPanel>No settled artifacts.</EmptyPanel>}
            </div>
            {source?.kind === "github_app" ? (
              <form
                className="pull-request-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void deliverPullRequest();
                }}
              >
                <div className="inspector-subheading">GitHub PR delivery</div>
                <label>
                  <span>base branch</span>
                  <input
                    disabled={mutation !== null}
                    onChange={(event) => setPullRequestBaseBranch(event.target.value)}
                    value={pullRequestBaseBranch}
                  />
                </label>
                <label>
                  <span>head branch</span>
                  <input
                    disabled={mutation !== null}
                    onChange={(event) => setPullRequestHeadBranch(event.target.value)}
                    value={pullRequestHeadBranch}
                  />
                </label>
                <label>
                  <span>title</span>
                  <input
                    disabled={mutation !== null}
                    onChange={(event) => setPullRequestTitle(event.target.value)}
                    value={pullRequestTitle}
                  />
                </label>
                <label>
                  <span>body</span>
                  <textarea
                    disabled={mutation !== null}
                    onChange={(event) => setPullRequestBody(event.target.value)}
                    rows={3}
                    value={pullRequestBody}
                  />
                </label>
                <button
                  disabled={
                    role === "viewer" ||
                    busy ||
                    mutation !== null ||
                    selectedVersionId === null ||
                    pullRequestBaseBranch.trim() === "" ||
                    pullRequestHeadBranch.trim() === "" ||
                    pullRequestTitle.trim() === ""
                  }
                  type="submit"
                >
                  create branch, commit, check & PR
                </button>
                {pullRequestDelivery ? (
                  <div className="pull-request-result">
                    <strong>{pullRequestDelivery.state}</strong>
                    <span>
                      {pullRequestDelivery.pullRequestNumber
                        ? `PR #${String(pullRequestDelivery.pullRequestNumber)}`
                        : `delivery ${shortId(pullRequestDelivery.deliveryId)}`}
                    </span>
                    {pullRequestDelivery.pullRequestUrl ? (
                      <a href={pullRequestDelivery.pullRequestUrl} rel="noreferrer" target="_blank">
                        open on GitHub
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </form>
            ) : null}
            {filePreview ? (
              <div className="safe-preview">
                <header>
                  <strong>{filePreview.path}</strong>
                  <span>
                    {filePreview.binary ? "binary" : "UTF-8 text"}
                    {filePreview.truncated ? " · preview truncated" : ""}
                  </span>
                </header>
                <pre>{filePreview.text}</pre>
              </div>
            ) : null}
            {artifactPreview ? (
              <div className="safe-preview">
                <header>
                  <strong>{artifactPreview.title}</strong>
                  <span>
                    {artifactPreview.truncated ? "preview truncated" : "safe text preview"}
                  </span>
                </header>
                <pre>{artifactPreview.text}</pre>
              </div>
            ) : null}
          </section>
        ) : null}

        {sessionId !== null && tab === "environment" ? (
          <section className="inspector-panel">
            <div className="inspector-section-heading">
              <div>
                <strong>Development environment</strong>
                <span>immutable recipe, validation evidence and CAS activation</span>
              </div>
              <div className="inspector-actions">
                <button
                  disabled={
                    role !== "owner" ||
                    busy ||
                    mutation !== null ||
                    selectedEnvironment === null ||
                    selectedEnvironment.state === "failed"
                  }
                  onClick={() => void validateEnvironmentVersion()}
                  type="button"
                >
                  validate
                </button>
                <button
                  disabled={
                    role !== "owner" ||
                    busy ||
                    mutation !== null ||
                    selectedEnvironment === null ||
                    selectedEnvironment.active ||
                    selectedEnvironment.state !== "validated"
                  }
                  onClick={() => void activateEnvironmentVersion()}
                  type="button"
                >
                  activate / rollback
                </button>
              </div>
            </div>
            {mutation ? <div className="inspector-progress">{mutation}…</div> : null}
            <label className="inspector-field">
              <span>version</span>
              <select
                onChange={(event) => setSelectedEnvironmentVersionId(event.target.value)}
                value={selectedEnvironmentVersionId ?? ""}
              >
                {environments?.versions.map((environment) => (
                  <option
                    key={environment.environmentVersionId}
                    value={environment.environmentVersionId}
                  >
                    v{String(environment.versionNumber)} · {environment.state}
                    {environment.active ? " · active" : ""}
                  </option>
                ))}
              </select>
            </label>
            {selectedEnvironment ? (
              <>
                <div className="inspector-metrics compact">
                  <Metric label="state" value={selectedEnvironment.state} />
                  <Metric label="image" value={shortId(selectedEnvironment.imageRevision)} />
                  <Metric label="recipe" value={shortId(selectedEnvironment.recipeSha256)} />
                </div>
                <div className="inspector-subheading">configuration as code</div>
                <textarea
                  aria-label="Environment recipe JSON"
                  disabled={role !== "owner" || mutation !== null}
                  onChange={(event) => setEnvironmentRecipeText(event.target.value)}
                  rows={14}
                  spellCheck={false}
                  value={environmentRecipeText}
                />
                <button
                  disabled={role !== "owner" || busy || mutation !== null}
                  onClick={() => void createEnvironmentVersion()}
                  type="button"
                >
                  create pending version from recipe
                </button>
                <p className="inspector-note">
                  Setup and verification commands run inside the untrusted gVisor Workspace before
                  Agent tools are enabled. Image, RuntimeClass, mounts and resource policy remain
                  operator-owned.
                </p>
                <div className="inspector-subheading">latest fresh-Sandbox evidence</div>
                {selectedEnvironment.latestValidation ? (
                  <div className="test-result-list">
                    {selectedEnvironment.latestValidation.recipeCommands.map((result) => (
                      <article className="test-result test-passed" key={result.id}>
                        <header>
                          <strong>{result.id}</strong>
                          <span>{result.phase}</span>
                        </header>
                        <small>
                          exit {String(result.exitCode)} · {durationLabel(result.durationMs)} ·
                          output {shortId(result.outputSha256)}
                        </small>
                      </article>
                    ))}
                    <div className="inspector-metrics compact">
                      <Metric
                        label="boundary"
                        value={`${selectedEnvironment.latestValidation.runtime}/gVisor`}
                      />
                      <Metric
                        label="network"
                        value={selectedEnvironment.latestValidation.networkMode}
                      />
                      <Metric label="user" value={selectedEnvironment.latestValidation.runAsUser} />
                    </div>
                  </div>
                ) : (
                  <EmptyPanel>No successful physical validation has been committed.</EmptyPanel>
                )}
                <div className="inspector-subheading">environment audit</div>
                <div className="audit-list">
                  {environments?.operations.map((operation) => (
                    <article key={operation.operationId}>
                      <header>
                        <span>environment</span>
                        <strong>{operation.kind}</strong>
                        <em>{shortId(operation.toEnvironmentVersionId)}</em>
                      </header>
                      <p>
                        {operation.fromEnvironmentVersionId
                          ? `${shortId(operation.fromEnvironmentVersionId)} → `
                          : ""}
                        {shortId(operation.toEnvironmentVersionId)}
                      </p>
                      <small>{timestampLabel(operation.createdAt)}</small>
                    </article>
                  )) ?? <EmptyPanel>No environment operations.</EmptyPanel>}
                </div>
              </>
            ) : (
              <EmptyPanel>No environment version is available.</EmptyPanel>
            )}
          </section>
        ) : null}

        {sessionId !== null && tab === "runs" ? (
          <section className="inspector-panel">
            <div className="inspector-section-heading">
              <div>
                <strong>Durable runs</strong>
                <span>{String(runs?.runs.length ?? 0)} visible</span>
              </div>
              <button
                disabled={
                  busy ||
                  selectedRun === null ||
                  !TERMINAL_RETRY_STATES.has(selectedRun.state) ||
                  role === "viewer"
                }
                onClick={() => void retrySelectedRun()}
                type="button"
              >
                retry as new run
              </button>
            </div>
            <label className="inspector-field">
              <span>run</span>
              <select
                onChange={(event) => setSelectedRunId(event.target.value)}
                value={selectedRunId ?? ""}
              >
                {runs?.runs.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {shortId(run.runId)} · {run.state} · {String(run.attemptCount)} attempt(s)
                  </option>
                ))}
              </select>
            </label>
            {selectedRun === null ? (
              <EmptyPanel>No Run has been submitted.</EmptyPanel>
            ) : (
              <>
                <div className="inspector-metrics compact">
                  <Metric label="state" value={selectedRun.state} />
                  <Metric label="attempts" value={String(selectedRun.attemptCount)} />
                  <Metric label="trace" value={shortId(selectedRun.traceId)} />
                </div>
                {selectedRun.failure ? (
                  <div className="inspector-warning">
                    {selectedRun.failure.code} · {selectedRun.failure.message ?? "no detail"}
                  </div>
                ) : null}
                <div className="attempt-list">
                  {selectedRun.attempts.map((attempt) => (
                    <details
                      key={attempt.attemptId}
                      open={attempt.attemptId === selectedRun.currentAttemptId}
                    >
                      <summary>
                        attempt {String(attempt.attemptNumber)} · {attempt.state} · owner{" "}
                        {attempt.claimOwnerId}
                      </summary>
                      <div className="attempt-detail">
                        <span>lease expires {timestampLabel(attempt.claimExpiresAt)}</span>
                        <span>
                          fence {attempt.fencingToken ?? "—"} · sandbox{" "}
                          {attempt.sandboxId ? shortId(attempt.sandboxId) : "—"}
                        </span>
                        {attempt.transitions.map((transition, index) => (
                          <div
                            className="attempt-transition"
                            key={`${transition.occurredAt}:${String(index)}`}
                          >
                            <time>{timestampLabel(transition.occurredAt)}</time>
                            <strong>{transition.toState}</strong>
                            <span>{transition.reason}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </>
            )}
          </section>
        ) : null}

        {sessionId !== null && tab === "tests" ? (
          <section className="inspector-panel">
            <div className="inspector-section-heading">
              <div>
                <strong>Test evidence</strong>
                <span>captured from recognized test commands</span>
              </div>
            </div>
            <label className="inspector-field">
              <span>run</span>
              <select
                onChange={(event) => setSelectedRunId(event.target.value)}
                value={selectedRunId ?? ""}
              >
                {runs?.runs.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {shortId(run.runId)} · {run.state}
                  </option>
                ))}
              </select>
            </label>
            <div className="test-result-list">
              {testResults?.results.length ? (
                testResults.results.map((result) => (
                  <article
                    className={`test-result test-${result.status}`}
                    key={result.testResultId}
                  >
                    <header>
                      <strong>{result.suite}</strong>
                      <span>{result.status}</span>
                    </header>
                    <code>{result.command}</code>
                    <p>{result.summary ?? "No summary was emitted."}</p>
                    <small>
                      exit {result.exitCode ?? "—"} · {durationLabel(result.durationMs)}
                    </small>
                  </article>
                ))
              ) : (
                <EmptyPanel>No structured test result for this Run.</EmptyPanel>
              )}
            </div>
          </section>
        ) : null}

        {sessionId !== null && tab === "usage" ? (
          <section className="inspector-panel">
            <div className="inspector-section-heading">
              <div>
                <strong>Usage & context</strong>
                <span>tenant ledger plus selected Run audit</span>
              </div>
            </div>
            <div className="inspector-subheading">tenant total</div>
            <div className="inspector-metrics">
              <Metric label="requests" value={String(usage?.totals.requests ?? 0)} />
              <Metric
                label="tokens"
                value={String((usage?.totals.inputTokens ?? 0) + (usage?.totals.outputTokens ?? 0))}
              />
              <Metric label="cost" value={costLabel(usage?.totals.costMicrousd ?? 0)} />
            </div>
            <div className="inspector-subheading">selected run</div>
            <div className="inspector-metrics">
              <Metric label="requests" value={String(runUsage?.totals.requests ?? 0)} />
              <Metric label="input" value={String(runUsage?.totals.inputTokens ?? 0)} />
              <Metric label="output" value={String(runUsage?.totals.outputTokens ?? 0)} />
              <Metric label="cost" value={costLabel(runUsage?.totals.costMicrousd ?? 0)} />
            </div>
            <div className="model-request-list">
              {runUsage?.modelRequests.map((request) => (
                <div key={request.requestId}>
                  <strong>
                    #{String(request.sequence)} · {request.state}
                  </strong>
                  <span>
                    {request.actualProvider ?? request.requestedProvider}/
                    {request.actualModelId ?? request.requestedModelId}
                  </span>
                  <small>
                    {String(request.actualTokens ?? request.reservedTokens)} tokens ·{" "}
                    {costLabel(request.actualCostMicrousd ?? request.reservedCostMicrousd)}
                  </small>
                </div>
              ))}
            </div>
            <div className="inspector-subheading">governance</div>
            <div className="inspector-metrics">
              <Metric
                label="model requests"
                value={String(governance?.limits.maximumModelRequestsPerRun ?? 0)}
              />
              <Metric
                label="tool calls"
                value={String(governance?.limits.maximumToolCallsPerRun ?? 0)}
              />
              <Metric
                label="wall clock"
                value={durationLabel(governance?.limits.maximumRunDurationMs)}
              />
              <Metric
                label="monthly budget"
                value={costLabel(governance?.limits.monthlyCostMicrousdBudget ?? 0)}
              />
            </div>
            <div className="inspector-subheading">context layers & compaction</div>
            <div className="context-layer-list">
              {context?.layers.map((layer) => (
                <div key={layer.kind}>
                  <span>L{String(layer.order)}</span>
                  <strong>{layer.kind.replaceAll("_", " ")}</strong>
                  <small>{layer.availability}</small>
                </div>
              ))}
            </div>
            <div className="compaction-list">
              {context?.history.map((entry) => (
                <div key={entry.compactionId}>
                  <strong>{entry.state}</strong>
                  <span>
                    {entry.reason} · {String(entry.tokensBefore ?? 0)} →{" "}
                    {String(entry.estimatedTokensAfter ?? 0)} tokens
                  </span>
                  <small>{timestampLabel(entry.startedAt)}</small>
                </div>
              ))}
              {context?.history.length === 0 ? (
                <EmptyPanel>No context compaction has been required.</EmptyPanel>
              ) : null}
            </div>
          </section>
        ) : null}

        {sessionId !== null && tab === "activity" ? (
          <section className="inspector-panel">
            <div className="inspector-section-heading">
              <div>
                <strong>Operations & audit</strong>
                <span>{role === "owner" ? "tenant owner view" : "owner role required"}</span>
              </div>
            </div>
            {role !== "owner" ? (
              <EmptyPanel>
                Operational aggregates and the cross-system audit feed are owner-only.
              </EmptyPanel>
            ) : (
              <>
                <div className="inspector-metrics">
                  <Metric label="queued" value={String(operations?.runs.queued ?? 0)} />
                  <Metric label="active" value={String(operations?.runs.active ?? 0)} />
                  <Metric
                    label="success"
                    value={`${((operations?.runs.successRateBasisPoints ?? 0) / 100).toFixed(2)}%`}
                  />
                  <Metric label="p95 run" value={durationLabel(operations?.runs.execution.p95Ms)} />
                  <Metric
                    label="sandboxes"
                    value={String(operations?.activeSandboxAssignments ?? 0)}
                  />
                  <Metric label="tool failures" value={String(operations?.tools.failures ?? 0)} />
                </div>
                <div className="inspector-subheading">immutable activity feed</div>
                <div className="audit-list">
                  {audit?.events.length ? (
                    audit.events.map((event) => (
                      <article key={event.eventId}>
                        <header>
                          <span>{event.category}</span>
                          <strong>{event.action}</strong>
                          <em>{event.state}</em>
                        </header>
                        <p>{event.summary}</p>
                        <small>
                          {timestampLabel(event.occurredAt)} · {shortId(event.subjectId)}
                        </small>
                      </article>
                    ))
                  ) : (
                    <EmptyPanel>No durable audit activity for this tenant.</EmptyPanel>
                  )}
                  {audit?.truncated ? (
                    <div className="inspector-progress">Newest 100 events shown.</div>
                  ) : null}
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
