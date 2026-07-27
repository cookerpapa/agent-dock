# ADR-0069: Cube-only runtime and Workspace-first conversations

- Status: Accepted
- Date: 2026-07-27
- Supersedes: executable gVisor importer/bootstrap paths and the operations-first Workspace inspector
- Refines: ADR-0068

## Context

Agent Dock's untrusted Tool execution already runs in CubeSandbox, but the
repository still constructed a Kubernetes gVisor provider for repository
imports and dependency bootstrap. That left two executable isolation paths,
two deployment stacks and misleading product copy even though Cube is the
primary runtime.

The browser also exposed infrastructure concepts rather than the product
model. A conversation implicitly created a Project and Workspace, repository
import was a top-level action, and the Workspace drawer loaded unrelated
operational, governance, race, usage and environment endpoints as one
all-or-nothing request. Any one rejected request blanked and repeatedly
reloaded the drawer.

Finally, a tenant `owner` was treated as if it were the platform operator.
Platform settings are deployment-wide authority and must not appear in an
ordinary tenant's conversation product.

## Decision

### Cube is the only executable Sandbox runtime

The Sandbox Manager constructs only `CubeSandboxProvider`. Environment setup
executes inside the same Cube activation through the deployment-owned outbound
proxy. The gVisor provider, Kubernetes runtime client, dependency bootstrap
proxy, execution-plane Helm chart and their runtime configuration are removed.
There is no runc or gVisor fallback.

Historical ADRs and database migrations remain immutable records. Current
source, deployment manifests, tests and product documentation must not present
gVisor as an available runtime.

### A Workspace is a user-visible directory

A Workspace is the durable `/workspace` directory shared by conversations that
the user explicitly associates with it. Creating a conversation requires:

1. a conversation title; and
2. selecting an existing Workspace or creating a named empty Workspace.

The Workspace UI shows the current directory version, files and file contents.
Operational diagnostics remain available through service telemetry and
administrative APIs, not the end-user directory inspector.

`workspaces.current_workspace_version_id` is the authoritative committed
directory head. Ordinary conversations keep a mirror of that pointer for
read-model compatibility, but never own it. Every ordinary Run refreshes its
base from the Workspace head when it is claimed, and a completed Tool Run
advances the head with compare-and-set before all ordinary conversations are
refreshed. Pi checkpoints remain Session-scoped, so selecting an existing
Workspace never imports another conversation's transcript.

Only explicit Fork/Candidate-Race Sessions are isolated branches. Their
Workspace versions remain Session-local until an explicit promotion advances
the shared Workspace head. This preserves parallel candidate evaluation
without weakening ordinary conversation consistency.

Kopia checkpoint format v2 records the Session that produced a snapshot as
provenance, but does not bind restore to that Session. A new conversation
restores the shared committed snapshot into its own Session-scoped POSIX
volume. This keeps live process trees and candidate branches isolated while
making committed `/workspace` bytes portable between conversations. The old
Session-bound checkpoint format is deliberately unsupported during this
pre-release cutover; incompatible development data is reset instead of
retaining a second compatibility path.

Repository import is removed from the browser. A connected Sandbox can clone
or download repositories using normal Tools, so import is no longer a separate
product workflow.

### Conversations are independently named and softly deleted

Conversation titles are stored on `sessions`, independent of the Workspace
name. Delete is a durable soft delete using `sessions.archived_at`; archived
conversations disappear from the list and cannot be reopened through the
conversation API. The durable execution and Workspace history remain available
for retention and audit policy.

### Platform administration is a separate product surface

`TenantIdentityResource` explicitly reports `platformAdministrator`. The
platform administrator is still selected by the deployment-owned operator
tenant identifier, but that account lands on a dedicated settings page and
does not enter the ordinary conversation UI.

Tenant `owner` means ownership of one tenant only. It never grants platform
settings access. The existing `tuhao` tenant becomes ordinary when a dedicated
administrator tenant is configured.

## Consequences

- There is one untrusted execution architecture to test, deploy and explain.
- Cube startup and environment setup use the same isolation and outbound
  network policy.
- Existing repository-import UI and gVisor deployment compatibility are
  intentionally removed.
- Multiple conversations can share one Workspace while keeping distinct
  titles and transcripts.
- Shared committed snapshots restore into a conversation-private live volume;
  live processes and uncommitted bytes are never transferred between
  conversations.
- Ordinary Runs for the same Workspace are serialized; different Workspaces
  and isolated candidate branches can still execute concurrently.
- The Workspace drawer no longer fails because an unrelated operational API
  denied or timed out.
- Platform settings authority is visible and testable in the identity contract.

## Acceptance

1. no current source or deployment manifest constructs or offers gVisor;
2. the browser has no repository-import action or gVisor badge;
3. creating a conversation requires a title and an existing/new Workspace;
4. two conversations can target the same Workspace, see the same committed
   files, cold-restore them into separate live volumes and retain separate Pi
   transcripts;
5. deleting a conversation removes it from listing and direct opening;
6. the Workspace drawer renders files without unrelated inspector requests or
   reload loops;
7. `tuhao` has no platform settings access;
8. the dedicated administrator lands directly on the settings page; and
9. build, automated tests and a real browser/API regression pass.
