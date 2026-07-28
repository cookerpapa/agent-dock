import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileResource, WorkspaceVersionResource } from "@agent-dock/protocol";
import { AgentDockApi, AgentDockApiError } from "./api.ts";

export const MAXIMUM_WORKSPACE_PREVIEW_BYTES = 512 * 1_024;

export type DirectoryEntry =
  | Readonly<{ kind: "directory"; path: string; depth: number; name: string }>
  | Readonly<{
      kind: "file";
      path: string;
      depth: number;
      name: string;
      file: WorkspaceFileResource;
    }>;

function message(error: unknown): string {
  if (error instanceof AgentDockApiError) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) {
    return `Workspace 目录读取失败：${error.message}`;
  }
  return "Workspace 目录暂时无法读取。";
}

export function directoryEntries(
  files: readonly WorkspaceFileResource[],
): readonly DirectoryEntry[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [
    ...[...directories].map((path) => ({
      kind: "directory" as const,
      path,
      depth: path.split("/").length - 1,
      name: path.split("/").at(-1) ?? path,
    })),
    ...files.map((file) => ({
      kind: "file" as const,
      path: file.path,
      depth: file.path.split("/").length - 1,
      name: file.path.split("/").at(-1) ?? file.path,
      file,
    })),
  ].sort((left, right) => {
    const leftParts = left.path.split("/");
    const rightParts = right.path.split("/");
    const commonLength = Math.min(leftParts.length, rightParts.length);
    for (let index = 0; index < commonLength; index += 1) {
      if (leftParts[index] === rightParts[index]) continue;
      const leftIsDirectory = index < leftParts.length - 1 || left.kind === "directory";
      const rightIsDirectory = index < rightParts.length - 1 || right.kind === "directory";
      if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
      return (leftParts[index] ?? "").localeCompare(rightParts[index] ?? "");
    }
    return leftParts.length - rightParts.length;
  });
}

function parentDirectory(path: string): string | null {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? null : path.slice(0, separator);
}

export function visibleDirectoryEntries(
  entries: readonly DirectoryEntry[],
  expandedDirectories: ReadonlySet<string>,
): readonly DirectoryEntry[] {
  return entries.filter((entry) => {
    let parent = parentDirectory(entry.path);
    while (parent !== null) {
      if (!expandedDirectories.has(parent)) return false;
      parent = parentDirectory(parent);
    }
    return true;
  });
}

export function canPreviewWorkspaceFile(file: WorkspaceFileResource): boolean {
  return file.sizeBytes <= MAXIMUM_WORKSPACE_PREVIEW_BYTES;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

function decodedText(bytes: Uint8Array): string | null {
  if (bytes.some((byte) => byte === 0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function WorkspaceInspector({
  api,
  onClose,
  onError,
  refreshSignal,
  sessionId,
  workspaceName,
}: {
  api: AgentDockApi;
  onClose: () => void;
  onError: (message: string) => void;
  refreshSignal: number;
  sessionId: string | null;
  workspaceName: string | null;
}) {
  const [version, setVersion] = useState<WorkspaceVersionResource | null>(null);
  const [files, setFiles] = useState<readonly WorkspaceFileResource[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [selectedBinary, setSelectedBinary] = useState(false);
  const [selectedTooLarge, setSelectedTooLarge] = useState(false);
  const [rootExpanded, setRootExpanded] = useState(true);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const onErrorRef = useRef(onError);
  const directoryLoadGeneration = useRef(0);
  const fileLoadGeneration = useRef(0);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    directoryLoadGeneration.current += 1;
    fileLoadGeneration.current += 1;
    setRootExpanded(true);
    setExpandedDirectories(new Set());
    setVersion(null);
    setFiles([]);
    setSelectedPath(null);
    setSelectedText(null);
    setSelectedBinary(false);
    setSelectedTooLarge(false);
    setLoading(false);
    setFileLoading(false);
  }, [sessionId]);

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === null) {
      setVersion(null);
      setFiles([]);
      setSelectedPath(null);
      setSelectedText(null);
      return;
    }
    const generation = ++directoryLoadGeneration.current;
    fileLoadGeneration.current += 1;
    setLoading(true);
    setFileLoading(false);
    setSelectedPath(null);
    setSelectedText(null);
    setSelectedBinary(false);
    setSelectedTooLarge(false);
    try {
      const versions = await api.listWorkspaceVersions(sessionId);
      if (generation !== directoryLoadGeneration.current) return;
      const current =
        versions.currentVersionId === undefined
          ? null
          : (versions.versions.find((item) => item.versionId === versions.currentVersionId) ??
            null);
      setVersion(current);
      if (current === null) {
        setFiles([]);
        setSelectedPath(null);
        setSelectedText(null);
        return;
      }
      const listedFiles: WorkspaceFileResource[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const listed = await api.listWorkspaceFiles(current.versionId, cursor);
        if (listed.versionId !== current.versionId) {
          throw new Error("目录分页返回了错误的 Workspace 版本");
        }
        listedFiles.push(...listed.files);
        if (!listed.truncated) break;
        if (listed.nextCursor === undefined || seenCursors.has(listed.nextCursor)) {
          throw new Error("目录分页游标无效");
        }
        seenCursors.add(listed.nextCursor);
        cursor = listed.nextCursor;
      }
      if (generation !== directoryLoadGeneration.current) return;
      setFiles(listedFiles);
    } catch (error: unknown) {
      if (generation === directoryLoadGeneration.current) {
        setVersion(null);
        setFiles([]);
        onErrorRef.current(message(error));
      }
    } finally {
      if (generation === directoryLoadGeneration.current) setLoading(false);
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
    return () => {
      directoryLoadGeneration.current += 1;
      fileLoadGeneration.current += 1;
    };
  }, [refresh, refreshSignal]);

  async function openFile(file: WorkspaceFileResource): Promise<void> {
    if (version === null) return;
    const generation = ++fileLoadGeneration.current;
    const previewable = canPreviewWorkspaceFile(file);
    setSelectedPath(file.path);
    setSelectedText(null);
    setSelectedBinary(false);
    setSelectedTooLarge(!previewable);
    if (!previewable) {
      setFileLoading(false);
      return;
    }
    setFileLoading(true);
    try {
      const result = await api.readWorkspaceFile(version.versionId, file.path);
      if (generation !== fileLoadGeneration.current) return;
      const text = decodedText(result.bytes);
      setSelectedText(text);
      setSelectedBinary(text === null);
    } catch (error: unknown) {
      if (generation === fileLoadGeneration.current) onErrorRef.current(message(error));
    } finally {
      if (generation === fileLoadGeneration.current) setFileLoading(false);
    }
  }

  const entries = useMemo(() => directoryEntries(files), [files]);
  const visibleEntries = useMemo(
    () => (rootExpanded ? visibleDirectoryEntries(entries, expandedDirectories) : []),
    [entries, expandedDirectories, rootExpanded],
  );
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;

  function toggleDirectory(path: string): void {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <aside className="workspace-directory" aria-label="Workspace 目录">
      <header className="workspace-directory-header">
        <div>
          <span>WORKSPACE</span>
          <strong>{workspaceName ?? "/workspace"}</strong>
          <small>/workspace</small>
        </div>
        <div>
          <button disabled={loading} onClick={() => void refresh()} title="刷新目录" type="button">
            ↻
          </button>
          <button onClick={onClose} title="关闭" type="button">
            ×
          </button>
        </div>
      </header>
      <div className="workspace-directory-meta">
        {version === null
          ? "尚无已提交的文件版本"
          : `版本 ${String(version.versionNumber)} · ${String(version.fileCount)} 个文件`}
      </div>
      <div className="workspace-directory-body">
        <nav className="workspace-file-tree" aria-label="/workspace 文件">
          <button
            aria-expanded={rootExpanded}
            className="workspace-root-row"
            onClick={() => setRootExpanded((expanded) => !expanded)}
            type="button"
          >
            <span>{rootExpanded ? "▾" : "▸"}</span>
            <strong>/workspace</strong>
          </button>
          {loading ? (
            <div className="workspace-empty">正在读取目录…</div>
          ) : entries.length === 0 ? (
            <div className="workspace-empty">
              这个目录还是空的。让 Agent 创建文件后，完成的版本会显示在这里。
            </div>
          ) : (
            visibleEntries.map((entry) =>
              entry.kind === "directory" ? (
                <button
                  aria-expanded={expandedDirectories.has(entry.path)}
                  className="workspace-tree-directory"
                  key={`directory:${entry.path}`}
                  onClick={() => toggleDirectory(entry.path)}
                  style={{ paddingLeft: `${String(16 + entry.depth * 16)}px` }}
                  title={entry.path}
                  type="button"
                >
                  <span>{expandedDirectories.has(entry.path) ? "▾" : "▸"}</span>
                  <span>{entry.name}</span>
                </button>
              ) : (
                <button
                  className={`workspace-tree-file${selectedPath === entry.path ? " active" : ""}`}
                  key={`file:${entry.path}`}
                  onClick={() => void openFile(entry.file)}
                  style={{ paddingLeft: `${String(18 + entry.depth * 16)}px` }}
                  title={entry.path}
                  type="button"
                >
                  <span>{entry.file.executable ? "◆" : "·"}</span>
                  <span>{entry.name}</span>
                  <small>{sizeLabel(entry.file.sizeBytes)}</small>
                </button>
              ),
            )
          )}
        </nav>
        <section className="workspace-file-preview">
          {selectedFile === null ? (
            <div className="workspace-preview-empty">
              <span>选择一个文件</span>
              <small>文件内容来自当前已提交的 Workspace 版本。</small>
            </div>
          ) : (
            <>
              <header>
                <strong>{selectedFile.path}</strong>
                <span>{sizeLabel(selectedFile.sizeBytes)}</span>
              </header>
              {fileLoading ? (
                <div className="workspace-preview-empty">正在读取文件…</div>
              ) : selectedTooLarge ? (
                <div className="workspace-preview-empty">
                  <span>文件较大，无法在线预览</span>
                  <small>
                    网页预览上限为 {sizeLabel(MAXIMUM_WORKSPACE_PREVIEW_BYTES)}
                    ，Agent 仍可在 Sandbox 中读取和处理此文件。
                  </small>
                </div>
              ) : selectedBinary ? (
                <div className="workspace-preview-empty">这是二进制文件，无法在此预览。</div>
              ) : (
                <pre>
                  <code>{selectedText ?? ""}</code>
                </pre>
              )}
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
