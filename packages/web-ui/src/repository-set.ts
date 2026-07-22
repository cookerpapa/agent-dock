import {
  ControlPlaneApiValidationError,
  parseCreateProjectRequest,
  type RepositorySetSourceRequest,
} from "@agent-dock/protocol";

export const REPOSITORY_SET_EXAMPLE = `[
  {
    "root": "frontend",
    "kind": "github_public",
    "repository": "owner/frontend",
    "commitSha": "0000000000000000000000000000000000000000"
  },
  {
    "root": "backend",
    "kind": "github_public",
    "repository": "owner/backend",
    "commitSha": "0000000000000000000000000000000000000000"
  }
]`;

export function parseRepositorySetManifest(value: string): RepositorySetSourceRequest {
  let repositories: unknown;
  try {
    repositories = JSON.parse(value);
  } catch {
    throw new ControlPlaneApiValidationError("Repository-set manifest must be valid JSON");
  }
  const request = parseCreateProjectRequest({
    name: "repository set",
    source: { kind: "repository_set", repositories },
  });
  const source = request.source;
  if (source?.kind !== "repository_set") {
    throw new ControlPlaneApiValidationError("Repository-set manifest was not preserved");
  }
  return source;
}

export function repositorySetLabel(source: RepositorySetSourceRequest): string {
  return `${String(source.repositories.length)} repositories · ${source.repositories
    .map((repository) => repository.root)
    .join(", ")}`;
}
