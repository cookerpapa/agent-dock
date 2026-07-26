export const TRUSTED_WORKSPACE_METADATA_DIRECTORY = ".agent-dock-runtime";

export function isTrustedWorkspaceMetadataPath(path: string): boolean {
  const [root] = path.split("/");
  return root === TRUSTED_WORKSPACE_METADATA_DIRECTORY;
}
