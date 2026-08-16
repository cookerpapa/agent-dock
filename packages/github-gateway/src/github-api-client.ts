import {
  createWorkspaceSnapshot,
  parseWorkspaceSnapshot,
  type WorkspaceSnapshotFileContent,
} from "@pi-cloud/workspace-runtime";
import { GitHubAppAuthentication } from "./github-app-auth.ts";
import { GitHubGatewayError, type GitHubInstallation, type GitHubRepository } from "./types.ts";

const MAX_TREE_ENTRIES = 512;
const MAX_PAGES = 10;

type JsonRecord = Record<string, unknown>;

export type PullRequestDeliveryInput = {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  baseBranch: string;
  baseCommitSha: string;
  headBranch: string;
  title: string;
  body: string;
  workspaceSnapshot: Uint8Array;
};

export type PullRequestDeliveryResult = {
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  checkRunId: number;
};

function record(value: unknown, description: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubGatewayError(
      "github_invalid_response",
      `GitHub ${description} is invalid`,
      false,
    );
  }
  return value as JsonRecord;
}

function string(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new GitHubGatewayError(
      "github_invalid_response",
      `GitHub ${description} is invalid`,
      false,
    );
  }
  return value;
}

function integer(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GitHubGatewayError(
      "github_invalid_response",
      `GitHub ${description} is invalid`,
      false,
    );
  }
  return value;
}

function boolean(value: unknown, description: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubGatewayError(
      "github_invalid_response",
      `GitHub ${description} is invalid`,
      false,
    );
  }
  return value;
}

function sha(value: unknown, description: string): string {
  const parsed = string(value, description).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(parsed)) {
    throw new GitHubGatewayError(
      "github_invalid_response",
      `GitHub ${description} is invalid`,
      false,
    );
  }
  return parsed;
}

function canonicalBase64(value: unknown): Buffer {
  const encoded = string(value, "blob content").replace(/\n/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new GitHubGatewayError(
      "github_invalid_response",
      "GitHub blob encoding is invalid",
      false,
    );
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new GitHubGatewayError(
      "github_invalid_response",
      "GitHub blob encoding is invalid",
      false,
    );
  }
  return bytes;
}

function repositoryResource(value: unknown, installationId: number): GitHubRepository {
  const row = record(value, "repository");
  const owner = record(row.owner, "repository owner");
  return {
    repositoryId: integer(row.id, "repository ID"),
    installationId,
    fullName: string(row.full_name, "repository full name"),
    ownerLogin: string(owner.login, "repository owner login"),
    name: string(row.name, "repository name"),
    private: boolean(row.private, "repository visibility"),
    defaultBranch: string(row.default_branch, "repository default branch"),
  };
}

function encodeReference(branch: string): string {
  return branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export class GitHubApiClient {
  readonly #authentication: GitHubAppAuthentication;
  readonly #fetch: typeof fetch;

  constructor(authentication: GitHubAppAuthentication, fetchImplementation?: typeof fetch) {
    this.#authentication = authentication;
    this.#fetch = fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }

  async inspectInstallation(installationId: number): Promise<GitHubInstallation> {
    const installation = record(
      await this.#request(`/app/installations/${installationId}`, {
        authorization: `Bearer ${this.#authentication.appJwt()}`,
      }),
      "installation",
    );
    const account = record(installation.account, "installation account");
    const targetType = installation.target_type;
    const selection = installation.repository_selection;
    if (
      (targetType !== "User" && targetType !== "Organization") ||
      (selection !== "all" && selection !== "selected")
    ) {
      throw new GitHubGatewayError(
        "github_invalid_response",
        "GitHub installation metadata is invalid",
        false,
      );
    }
    const permissions = record(installation.permissions, "installation permissions");
    const repositories = await this.#installationRepositories(installationId);
    return {
      installationId: integer(installation.id, "installation ID"),
      accountId: integer(account.id, "installation account ID"),
      accountLogin: string(account.login, "installation account login"),
      targetType,
      repositorySelection: selection,
      suspended: installation.suspended_at !== null && installation.suspended_at !== undefined,
      permissions: Object.fromEntries(
        Object.entries(permissions).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      repositories,
    };
  }

  async snapshot(
    installationId: number,
    repositoryId: number,
    commitSha: string,
  ): Promise<{ repository: GitHubRepository; commitSha: string; snapshot: Uint8Array }> {
    const repository = await this.#authorizedRepository(installationId, repositoryId);
    const token = await this.#authentication.installationToken(installationId);
    const commit = record(
      await this.#request(`/repositories/${repositoryId}/git/commits/${commitSha}`, {
        authorization: `Bearer ${token}`,
      }),
      "commit",
    );
    const resolvedSha = sha(commit.sha, "commit SHA");
    if (resolvedSha !== commitSha) {
      throw new GitHubGatewayError(
        "commit_mismatch",
        "GitHub did not resolve the requested exact commit",
        false,
      );
    }
    const tree = record(commit.tree, "commit tree");
    const files = await this.#treeFiles(token, repositoryId, sha(tree.sha, "tree SHA"));
    return { repository, commitSha: resolvedSha, snapshot: createWorkspaceSnapshot(files) };
  }

  async deliverPullRequest(input: PullRequestDeliveryInput): Promise<PullRequestDeliveryResult> {
    const repository = await this.#authorizedRepository(input.installationId, input.repositoryId);
    const token = await this.#authentication.installationToken(input.installationId);
    const baseReference = record(
      await this.#request(
        `/repositories/${input.repositoryId}/git/ref/heads/${encodeReference(input.baseBranch)}`,
        { authorization: `Bearer ${token}` },
      ),
      "base reference",
    );
    const baseObject = record(baseReference.object, "base reference object");
    if (sha(baseObject.sha, "base reference SHA") !== input.baseCommitSha) {
      throw new GitHubGatewayError(
        "base_commit_changed",
        "Pull request base branch no longer matches the selected commit",
        false,
      );
    }
    const baseCommit = record(
      await this.#request(
        `/repositories/${input.repositoryId}/git/commits/${input.baseCommitSha}`,
        {
          authorization: `Bearer ${token}`,
        },
      ),
      "base commit",
    );
    const baseTree = record(baseCommit.tree, "base commit tree");
    const baseTreeSha = sha(baseTree.sha, "base tree SHA");
    const baseEntries = await this.#treeEntries(token, input.repositoryId, baseTreeSha);
    const targetFiles = parseWorkspaceSnapshot(input.workspaceSnapshot);
    const targetPaths = new Set(targetFiles.map((file) => file.path));
    const treeEntries: Array<Record<string, unknown>> = [];
    for (const file of targetFiles) {
      const blob = record(
        await this.#request(
          `/repositories/${input.repositoryId}/git/blobs`,
          { authorization: `Bearer ${token}` },
          "POST",
          { content: file.content.toString("base64"), encoding: "base64" },
        ),
        "created blob",
      );
      treeEntries.push({
        path: file.path,
        mode: file.executable ? "100755" : "100644",
        type: "blob",
        sha: sha(blob.sha, "created blob SHA"),
      });
    }
    for (const entry of baseEntries) {
      if (entry.type === "blob" && !targetPaths.has(entry.path)) {
        treeEntries.push({ path: entry.path, mode: entry.mode, type: "blob", sha: null });
      }
    }
    const createdTree = record(
      await this.#request(
        `/repositories/${input.repositoryId}/git/trees`,
        { authorization: `Bearer ${token}` },
        "POST",
        { base_tree: baseTreeSha, tree: treeEntries },
      ),
      "created tree",
    );
    const targetTreeSha = sha(createdTree.sha, "created tree SHA");
    const existingHead = await this.#existingReference(token, input.repositoryId, input.headBranch);
    let commitSha: string;
    if (existingHead !== undefined) {
      await this.#assertCommitContent(
        token,
        input.repositoryId,
        existingHead,
        targetTreeSha,
        input.baseCommitSha,
      );
      commitSha = existingHead;
    } else {
      const createdCommit = record(
        await this.#request(
          `/repositories/${input.repositoryId}/git/commits`,
          { authorization: `Bearer ${token}` },
          "POST",
          {
            message: input.title,
            tree: targetTreeSha,
            parents: [input.baseCommitSha],
          },
        ),
        "created commit",
      );
      commitSha = await this.#ensureReference(
        token,
        input.repositoryId,
        input.headBranch,
        sha(createdCommit.sha, "created commit SHA"),
        targetTreeSha,
        input.baseCommitSha,
      );
    }
    const pullRequest = await this.#ensurePullRequest(token, repository, input, commitSha);
    const checkRun = record(
      await this.#request(
        `/repositories/${input.repositoryId}/check-runs`,
        { authorization: `Bearer ${token}` },
        "POST",
        {
          name: "PiCloud delivery",
          head_sha: commitSha,
          status: "completed",
          conclusion: "success",
          external_id: input.deliveryId,
          output: {
            title: "PiCloud run completed",
            summary: "Workspace checkpoint was delivered through the trusted GitHub Gateway.",
          },
        },
      ),
      "check run",
    );
    return {
      commitSha,
      pullRequestNumber: integer(pullRequest.number, "pull request number"),
      pullRequestUrl: string(pullRequest.html_url, "pull request URL"),
      checkRunId: integer(checkRun.id, "check run ID"),
    };
  }

  async #installationRepositories(installationId: number): Promise<GitHubRepository[]> {
    const token = await this.#authentication.installationToken(installationId);
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = record(
        await this.#request(`/installation/repositories?per_page=100&page=${page}`, {
          authorization: `Bearer ${token}`,
        }),
        "installation repositories",
      );
      if (!Array.isArray(response.repositories)) {
        throw new GitHubGatewayError(
          "github_invalid_response",
          "GitHub installation repositories are invalid",
          false,
        );
      }
      repositories.push(
        ...response.repositories.map((repository) =>
          repositoryResource(repository, installationId),
        ),
      );
      if (response.repositories.length < 100) return repositories;
    }
    throw new GitHubGatewayError(
      "repository_limit_exceeded",
      "GitHub installation contains too many repositories",
      false,
    );
  }

  async #authorizedRepository(
    installationId: number,
    repositoryId: number,
  ): Promise<GitHubRepository> {
    const repositories = await this.#installationRepositories(installationId);
    const repository = repositories.find((candidate) => candidate.repositoryId === repositoryId);
    if (repository === undefined) {
      throw new GitHubGatewayError(
        "repository_not_in_installation",
        "Repository does not belong to the GitHub App installation",
        false,
      );
    }
    return repository;
  }

  async #treeFiles(token: string, repositoryId: number, treeSha: string) {
    const entries = await this.#treeEntries(token, repositoryId, treeSha);
    const files: WorkspaceSnapshotFileContent[] = [];
    for (const entry of entries) {
      if (entry.type === "tree") continue;
      if (entry.type !== "blob") {
        throw new GitHubGatewayError(
          "unsupported_repository_entry",
          "Repository contains a submodule or unsupported entry",
          false,
        );
      }
      if (entry.mode === "120000") {
        throw new GitHubGatewayError(
          "unsupported_repository_entry",
          "Repository contains a symbolic link",
          false,
        );
      }
      const blob = record(
        await this.#request(`/repositories/${repositoryId}/git/blobs/${entry.sha}`, {
          authorization: `Bearer ${token}`,
        }),
        "blob",
      );
      if (blob.encoding !== "base64") {
        throw new GitHubGatewayError(
          "github_invalid_response",
          "GitHub blob encoding is unsupported",
          false,
        );
      }
      files.push({
        path: entry.path,
        executable: entry.mode === "100755",
        content: canonicalBase64(blob.content),
      });
    }
    return files;
  }

  async #treeEntries(
    token: string,
    repositoryId: number,
    treeSha: string,
  ): Promise<Array<{ path: string; mode: string; type: string; sha: string }>> {
    const tree = record(
      await this.#request(`/repositories/${repositoryId}/git/trees/${treeSha}?recursive=1`, {
        authorization: `Bearer ${token}`,
      }),
      "tree",
    );
    if (
      tree.truncated === true ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > MAX_TREE_ENTRIES
    ) {
      throw new GitHubGatewayError(
        "repository_limit_exceeded",
        "Repository tree exceeds the supported limit",
        false,
      );
    }
    return tree.tree.map((candidate) => {
      const entry = record(candidate, "tree entry");
      return {
        path: string(entry.path, "tree path"),
        mode: string(entry.mode, "tree mode"),
        type: string(entry.type, "tree type"),
        sha: sha(entry.sha, "tree entry SHA"),
      };
    });
  }

  async #ensureReference(
    token: string,
    repositoryId: number,
    branch: string,
    commitSha: string,
    treeSha: string,
    baseCommitSha: string,
  ): Promise<string> {
    try {
      await this.#request(
        `/repositories/${repositoryId}/git/refs`,
        { authorization: `Bearer ${token}` },
        "POST",
        { ref: `refs/heads/${branch}`, sha: commitSha },
      );
      return commitSha;
    } catch (error: unknown) {
      if (!(error instanceof GitHubGatewayError) || error.code !== "github_conflict") throw error;
    }
    const existing = record(
      await this.#request(
        `/repositories/${repositoryId}/git/ref/heads/${encodeReference(branch)}`,
        {
          authorization: `Bearer ${token}`,
        },
      ),
      "existing reference",
    );
    const object = record(existing.object, "existing reference object");
    const existingSha = sha(object.sha, "existing reference SHA");
    if (existingSha === commitSha) return commitSha;
    await this.#assertCommitContent(token, repositoryId, existingSha, treeSha, baseCommitSha);
    return existingSha;
  }

  async #existingReference(
    token: string,
    repositoryId: number,
    branch: string,
  ): Promise<string | undefined> {
    try {
      const existing = record(
        await this.#request(
          `/repositories/${repositoryId}/git/ref/heads/${encodeReference(branch)}`,
          { authorization: `Bearer ${token}` },
        ),
        "existing reference",
      );
      return sha(
        record(existing.object, "existing reference object").sha,
        "existing reference SHA",
      );
    } catch (error: unknown) {
      if (error instanceof GitHubGatewayError && error.code === "github_not_found")
        return undefined;
      throw error;
    }
  }

  async #assertCommitContent(
    token: string,
    repositoryId: number,
    commitSha: string,
    expectedTreeSha: string,
    expectedParentSha: string,
  ): Promise<void> {
    const commit = record(
      await this.#request(`/repositories/${repositoryId}/git/commits/${commitSha}`, {
        authorization: `Bearer ${token}`,
      }),
      "existing head commit",
    );
    const tree = record(commit.tree, "existing head tree");
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    const parentSha =
      parents.length === 1 ? sha(record(parents[0], "commit parent").sha, "parent SHA") : undefined;
    if (
      sha(tree.sha, "existing head tree SHA") !== expectedTreeSha ||
      parentSha !== expectedParentSha
    ) {
      throw new GitHubGatewayError(
        "head_branch_conflict",
        "Pull request branch already exists with different content",
        false,
      );
    }
  }

  async #ensurePullRequest(
    token: string,
    repository: GitHubRepository,
    input: PullRequestDeliveryInput,
    commitSha: string,
  ): Promise<JsonRecord> {
    try {
      return record(
        await this.#request(
          `/repositories/${repository.repositoryId}/pulls`,
          { authorization: `Bearer ${token}` },
          "POST",
          { title: input.title, body: input.body, head: input.headBranch, base: input.baseBranch },
        ),
        "pull request",
      );
    } catch (error: unknown) {
      if (!(error instanceof GitHubGatewayError) || error.code !== "github_conflict") throw error;
    }
    const pulls = await this.#request(
      `/repositories/${repository.repositoryId}/pulls?state=open&head=${encodeURIComponent(`${repository.ownerLogin}:${input.headBranch}`)}&base=${encodeURIComponent(input.baseBranch)}`,
      { authorization: `Bearer ${token}` },
    );
    if (!Array.isArray(pulls)) {
      throw new GitHubGatewayError(
        "github_invalid_response",
        "GitHub pull request list is invalid",
        false,
      );
    }
    const matching = pulls.find((candidate) => {
      const pull = record(candidate, "pull request");
      const head = record(pull.head, "pull request head");
      return head.sha === commitSha;
    });
    if (matching === undefined) {
      throw new GitHubGatewayError(
        "pull_request_conflict",
        "Existing pull request does not match delivered content",
        false,
      );
    }
    return record(matching, "pull request");
  }

  async #request(
    path: string,
    headers: { authorization: string },
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(this.#authentication.apiUrl(path), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: "application/vnd.github+json",
          authorization: headers.authorization,
          "content-type": "application/json",
          "user-agent": "pi-cloud-github-gateway",
          "x-github-api-version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error: unknown) {
      if (error instanceof GitHubGatewayError) throw error;
      throw new GitHubGatewayError("github_unavailable", "GitHub is unavailable", true);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new GitHubGatewayError(
        "github_invalid_response",
        "GitHub returned invalid JSON",
        false,
      );
    }
    if (!response.ok) {
      const code =
        response.status === 404
          ? "github_not_found"
          : response.status === 422
            ? "github_conflict"
            : "github_rejected";
      throw new GitHubGatewayError(
        code,
        "GitHub rejected the requested operation",
        response.status >= 500 || response.status === 429,
      );
    }
    return parsed;
  }
}
