# Trusted GitHub App integration

## Boundary

`github-gateway` is the only process that accepts a GitHub App private key and
obtains short-lived installation tokens. It has provider egress but no database,
model credential, object-storage credential, Docker socket, or user-code
execution capability.

```text
Web / Control Plane ──service RPC──> GitHub Gateway ──HTTPS──> GitHub API
Trusted Supervisor ───service RPC──> GitHub Gateway
Tool Sandbox       ─X─> GitHub Gateway / GitHub / installation token
```

The Gateway signs a bounded App JWT, caches installation tokens in memory only,
and never returns a token. Internal RPC uses a mounted service credential.

## Private import

1. A tenant owner registers a GitHub installation ID.
2. The Gateway inspects the installation and returns its repository IDs and
   permissions; the Control Plane persists a tenant allowlist.
3. A project selects installation ID, repository ID, and an exact 40-character
   commit SHA.
4. On first activation the trusted Supervisor asks the Gateway for that exact
   commit. The Gateway reads Git commit/tree/blob APIs, rejects truncated trees,
   symlinks, submodules and oversized manifests, and returns the canonical
   Workspace snapshot.
5. The Tool Sandbox receives only the snapshot. It remains networkless and has
   no GitHub credential.

## Pull-request delivery

The Control Plane reads a settled, tenant-owned WorkspaceVersion through the
trusted artifact channel. It creates a durable delivery record, then asks the
Gateway to create blobs, a tree based on the pinned base commit, a commit,
branch, Pull Request, and completed Check Run. Delivery requires `contents`,
`pull_requests`, and `checks` write permissions.

Retries reconcile an existing branch by comparing its commit tree and parent;
an existing PR must point to the reconciled commit. Durable idempotency prevents
one key from describing two deliveries. This is at-least-once external delivery
with reconciliation, not an exactly-once GitHub API claim.

## Webhooks

GitHub posts to `/webhooks/github`. The Gateway verifies `X-Hub-Signature-256`
over the raw bounded body and forwards only a normalized event plus raw-body
SHA-256 over authenticated internal RPC. The Control Plane stores each GitHub
delivery ID once and rejects content-changing replay. Installation removal or
suspension and repository removal disable future use.

## Configuration and current evidence

The default private deployment starts the Gateway in a fail-closed,
not-configured mode. Set `AGENT_DOCK_GITHUB_APP_ID` and replace
`secrets/github-app-private-key.pem` with the registered App private key to
enable live private import and PR delivery. Contract tests use a simulated
GitHub API and prove token isolation, exact-commit import, deletion-aware tree
creation, retry reconciliation, HMAC verification, and service authentication.
No live-GitHub claim is made unless the operator runs the documented acceptance
flow with their App installation.

