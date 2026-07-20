# ADR-0032: Versioned workspaces and trusted GitHub Gateway

- Status: accepted
- Date: 2026-07-20
- Extends: ADR-0011, ADR-0021, ADR-0028, ADR-0031

## Context

The settled checkpoint protocol kept one current Pi/workspace pointer per
Session. It preserved multi-turn state, but users could not inspect immutable
history, compare or restore revisions, fork a conversation at a known point, or
identify the exact bytes delivered to a code review. Public GitHub import also
deliberately had no reusable credential, so it could not read private
repositories or write branches and pull requests.

GitHub credentials must not be added to a Tool Sandbox merely to obtain those
features. Repository scripts and model-generated commands are untrusted; an
installation token in their environment would turn arbitrary code execution
into repository write authority.

## Decision

1. Every settled checkpoint creates an immutable, monotonically numbered
   `WorkspaceVersion` in the same transaction that advances the Session
   pointers. A version references the exact Pi/workspace artifacts, producing
   Run/Attempt, parent version, content revision and optional patch/test
   artifacts. The Session owns one CAS-protected current version.
2. Compare, fork, rollback and archive are Control Plane operations over
   immutable versions. Rollback advances the current pointer to an existing
   version; it never mutates or deletes history. Fork creates a new cold Session
   whose pointers and first version reference the selected immutable artifacts.
   Both operations require an expected current version, reject active work and
   write an audit record.
3. File browsing and downloads decode the canonical workspace manifest only in
   trusted services. Paths are validated against the manifest; object keys are
   never accepted from a browser. Binary content remains a bounded download.
   Diff, tests and published artifacts are separate typed resources attached to
   the producing Run/version.
4. A separate trusted `github-gateway` process is the only component holding a
   GitHub App private key and installation tokens. It exposes a narrow
   service-authenticated API for installation inspection, exact-commit snapshot
   import, branch/commit/PR delivery and Check Run updates. Tokens are
   short-lived, cached only in memory and never returned by the API.
5. Private source intake selects a tenant-allowlisted installation repository
   by immutable GitHub repository ID plus exact commit SHA. The browser cannot
   submit credentials, arbitrary URLs or an unregistered repository name.
6. Pull-request delivery consumes a committed WorkspaceVersion through trusted
   artifact transport. The Gateway writes blobs/tree/commit/ref/PR and records
   each externally visible identifier. Repeated delivery uses a durable
   idempotency key and reconciles an existing branch/PR before retrying; the
   system does not call GitHub side effects exactly once.
7. GitHub webhooks require HMAC-SHA256 verification over the raw bounded body
   and a unique delivery ID. Installation/repository/PR/check state is updated
   only after tenant ownership can be resolved. Duplicate deliveries return the
   stored result.

## Security boundary

```text
Browser -> Control Plane -> trusted GitHub Gateway -> api.github.com
                         \-> trusted artifact reader -> object storage

Trusted Runner -> GitHub Gateway (exact private snapshot)
Tool Sandbox  -X-> GitHub Gateway / installation token / Internet
```

The Gateway has no Docker socket, model key, database credential or user code
execution capability. The Control Plane has no GitHub App private key. The Tool
Sandbox has neither Gateway network reachability nor GitHub credentials.

## Consequences

- A PR and Check Run can be traced to immutable tenant/session/version/run
  identities rather than an unversioned working directory.
- Object-storage reads become a first-class trusted internal capability and
  require tenant/version validation before bytes are returned.
- GitHub API operations remain at-least-once external effects; durable delivery
  records and reconciliation make retries operator-visible and safe.
- Public exact-commit import remains supported without GitHub App setup. Private
  import and write-back fail closed when the Gateway is not configured.

## Rejected alternatives

### Put an installation token in the Tool Sandbox and run `git push`

Any repository command or compromised dependency could exfiltrate the token.
It also makes branch/PR idempotency invisible to the Control Plane.

### Overwrite the current checkpoint on rollback

That destroys provenance and permits stale workers to confuse which bytes were
reviewed. Pointer movement over immutable versions is simpler to audit.

### Let clients provide arbitrary object keys

Object keys are capabilities. Public APIs use tenant-owned version/artifact
UUIDs and resolve keys only after ownership checks.
