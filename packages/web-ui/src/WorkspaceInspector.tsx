import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileResource, WorkspaceVersionResource } from "@agent-dock/protocol";
import { AgentDockApi, AgentDockApiError } from "./api.ts";

type DirectoryEntry =
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

function directoryEntries(files: readonly WorkspaceFileResource[]): readonly DirectoryEntry[] {
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
    const leftParent = left.path.includes("/")
      ? left.path.slice(0, left.path.lastIndexOf("/"))
      : "";
    const rightParent = right.path.includes("/")
      ? right.path.slice(0, right.path.lastIndexOf("/"))
      : "";
    if (leftParent !== rightParent) return leftParent.localeCompare(rightParent);
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
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
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const onErrorRef = useRef(onError);
  const loadGeneration = useRef(0);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === null) {
      setVersion(null);
      setFiles([]);
      setSelectedPath(null);
      setSelectedText(null);
      return;
    }
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const versions = await api.listWorkspaceVersions(sessionId);
      if (generation !== loadGeneration.current) return;
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
      if (generation !== loadGeneration.current) return;
      setFiles(listedFiles);
      setSelectedPath((path) =>
        path !== null && listedFiles.some((file) => file.path === path) ? path : null,
      );
    } catch (error: unknown) {
      if (generation === loadGeneration.current) {
        setVersion(null);
        setFiles([]);
        onErrorRef.current(message(error));
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
    return () => {
      loadGeneration.current += 1;
    };
  }, [refresh, refreshSignal]);

  async function openFile(file: WorkspaceFileResource): Promise<void> {
    if (version === null) return;
    const generation = ++loadGeneration.current;
    setSelectedPath(file.path);
    setSelectedText(null);
    setSelectedBinary(false);
    setFileLoading(true);
    try {
      const result = await api.readWorkspaceFile(version.versionId, file.path);
      if (generation !== loadGeneration.current) return;
      const text = decodedText(result.bytes);
      setSelectedText(text);
      setSelectedBinary(text === null);
    } catch (error: unknown) {
      if (generation === loadGeneration.current) onErrorRef.current(message(error));
    } finally {
      if (generation === loadGeneration.current) setFileLoading(false);
    }
  }

  const entries = directoryEntries(files);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;

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
          <div className="workspace-root-row">
            <span>▾</span>
            <strong>/workspace</strong>
          </div>
          {loading ? (
            <div className="workspace-empty">正在读取目录…</div>
          ) : entries.length === 0 ? (
            <div className="workspace-empty">
              这个目录还是空的。让 Agent 创建文件后，完成的版本会显示在这里。
            </div>
          ) : (
            entries.map((entry) =>
              entry.kind === "directory" ? (
                <div
                  className="workspace-tree-directory"
                  key={`directory:${entry.path}`}
                  style={{ paddingLeft: `${String(16 + entry.depth * 16)}px` }}
                >
                  <span>▸</span>
                  {entry.name}
                </div>
              ) : (
                <button
                  className={selectedPath === entry.path ? "active" : ""}
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
