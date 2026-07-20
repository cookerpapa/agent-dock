export type GitHubRepository = {
  repositoryId: number;
  installationId: number;
  fullName: string;
  ownerLogin: string;
  name: string;
  private: boolean;
  defaultBranch: string;
};

export type GitHubInstallation = {
  installationId: number;
  accountId: number;
  accountLogin: string;
  targetType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  suspended: boolean;
  permissions: Record<string, string>;
  repositories: GitHubRepository[];
};

export type InspectInstallationRequest = {
  type: "installation.inspect";
  requestId: string;
  installationId: number;
};

export type ImportSnapshotRequest = {
  type: "repository.snapshot";
  requestId: string;
  installationId: number;
  repositoryId: number;
  commitSha: string;
};

export type DeliverPullRequestRequest = {
  type: "pull_request.deliver";
  requestId: string;
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  baseBranch: string;
  baseCommitSha: string;
  headBranch: string;
  title: string;
  body: string;
  workspaceSnapshotBase64: string;
};

export type GitHubGatewayRequest =
  InspectInstallationRequest | ImportSnapshotRequest | DeliverPullRequestRequest;

export type GitHubGatewayResponse =
  | {
      type: "installation.inspected";
      requestId: string;
      installation: GitHubInstallation;
    }
  | {
      type: "repository.snapshotted";
      requestId: string;
      repository: GitHubRepository;
      commitSha: string;
      workspaceSnapshotBase64: string;
    }
  | {
      type: "pull_request.delivered";
      requestId: string;
      deliveryId: string;
      commitSha: string;
      pullRequestNumber: number;
      pullRequestUrl: string;
      checkRunId: number;
    };

export type GitHubWebhookEvent = {
  deliveryId: string;
  eventName: string;
  payloadSha256: string;
  action?: string;
  installationId?: number;
  repositoryId?: number;
  repositoryFullName?: string;
  accountLogin?: string;
};

export class GitHubGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "GitHubGatewayError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GitHubGatewayError("invalid_request", `${name} is invalid`, false);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubGatewayError("invalid_request", `${name} is invalid`, false);
  }
  return value as Record<string, unknown>;
}

function bounded(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GitHubGatewayError("invalid_request", `${name} is invalid`, false);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const parsed = bounded(value, name, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) {
    throw new GitHubGatewayError("invalid_request", `${name} is invalid`, false);
  }
  return parsed;
}

function commitSha(value: unknown): string {
  const parsed = bounded(value, "commitSha", 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(parsed)) {
    throw new GitHubGatewayError("invalid_request", "commitSha is invalid", false);
  }
  return parsed;
}

function branch(value: unknown, name: string): string {
  const parsed = bounded(value, name, 240);
  if (
    parsed.startsWith("/") ||
    parsed.endsWith("/") ||
    parsed.endsWith(".") ||
    parsed.includes("..") ||
    parsed.includes("//") ||
    parsed.includes("@{") ||
    /[ ~^:?*\\[\]]/.test(parsed)
  ) {
    throw new GitHubGatewayError("invalid_request", `${name} is invalid`, false);
  }
  return parsed;
}

export function parseGatewayRequest(value: unknown): GitHubGatewayRequest {
  const input = record(value, "request");
  const type = input.type;
  const requestId = identifier(input.requestId, "requestId");
  const installationId = positiveSafeInteger(input.installationId, "installationId");
  if (type === "installation.inspect") {
    return { type, requestId, installationId };
  }
  const repositoryId = positiveSafeInteger(input.repositoryId, "repositoryId");
  if (type === "repository.snapshot") {
    return { type, requestId, installationId, repositoryId, commitSha: commitSha(input.commitSha) };
  }
  if (type === "pull_request.deliver") {
    const snapshot = bounded(input.workspaceSnapshotBase64, "workspaceSnapshotBase64", 12_000_000);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(snapshot)) {
      throw new GitHubGatewayError("invalid_request", "workspaceSnapshotBase64 is invalid", false);
    }
    return {
      type,
      requestId,
      deliveryId: identifier(input.deliveryId, "deliveryId"),
      installationId,
      repositoryId,
      baseBranch: branch(input.baseBranch, "baseBranch"),
      baseCommitSha: commitSha(input.baseCommitSha),
      headBranch: branch(input.headBranch, "headBranch"),
      title: bounded(input.title, "title", 256),
      body: typeof input.body === "string" && input.body.length <= 16_384 ? input.body : "",
      workspaceSnapshotBase64: snapshot,
    };
  }
  throw new GitHubGatewayError("invalid_request", "Gateway request type is invalid", false);
}
