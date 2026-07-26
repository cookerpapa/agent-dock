export {
  MAX_WORKSPACE_SNAPSHOT_FILE_BYTES,
  MAX_WORKSPACE_SNAPSHOT_FILES,
  MAX_WORKSPACE_SNAPSHOT_PATH_BYTES,
  MAX_PORTABLE_WORKSPACE_MANIFEST_BYTES,
  captureWorkspaceSnapshot,
  createWorkspaceSnapshot,
  mergeWorkspaceSnapshots,
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  restoreWorkspaceSnapshot,
  parseWorkspaceSnapshot,
  validateWorkspaceSnapshot,
  workspaceSnapshotFileCount,
  workspaceSnapshotMetadata,
  type WorkspaceSnapshotFileContent,
  type WorkspaceSnapshotMetadata,
} from "./workspace-snapshot.ts";

export { WorkspaceRuntimeError } from "./workspace-error.ts";
export {
  MAX_WORKSPACE_INDEX_FILES,
  MAX_WORKSPACE_INDEX_FILE_BYTES,
  MAX_WORKSPACE_INDEX_TOTAL_BYTES,
  captureWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceSnapshotFileMetadata,
  validateWorkspaceFileList,
} from "./workspace-index.ts";
export {
  KOPIA_WORKSPACE_CHECKPOINT_FORMAT,
  createKopiaWorkspaceCheckpoint,
  parseKopiaWorkspaceCheckpoint,
  type CreateKopiaWorkspaceCheckpointInput,
  type KopiaWorkspaceCheckpoint,
} from "./kopia-workspace-checkpoint.ts";

export { collectGitWorkspacePatch } from "./git-workspace-patch.ts";
