# ADR-0046: Capability-scoped public repository import

- Status: Accepted
- Date: 2026-07-22
- Extends: ADR-0028, ADR-0044

## Context

The public exact-commit importer originally had Kubernetes DNS and public
TCP/443 egress with private ranges excluded. That prevented direct platform
access but was not a hostname boundary, and direct public TLS from this
K3s/gVisor host was measurably unstable. The importer needs GitHub bytes, not
general Internet authority.

## Decision

The importer has `dnsPolicy: None` and a default-deny namespace. Its only
NetworkPolicy exception is TCP/3128 to the trusted capability proxy. For each
import the Sandbox Manager mints a short-lived Ed25519 capability whose only
host is `github.com`, with explicit connection, concurrency, byte and duration
ceilings. The capability and proxy endpoint enter the Pod only through the
closed attach protocol; neither is persisted in a Workspace or event.

The proxy performs DNS, rejects every non-public answer, accepts CONNECT on 443
only, and audits a hash of the import identity rather than the token. Git uses
explicit Basic proxy authentication, disables redirects, hooks, submodules,
LFS, credential helpers and interactive authentication, fetches only the exact
40-hex commit, removes `.git`, and returns a bounded canonical snapshot. The
Pod is then deleted with a UID precondition and absence is confirmed.

The stable Kubernetes policy object name is retained so an in-place manifest
upgrade replaces the former public-HTTPS rule instead of leaving a second,
wider policy active.

## Consequences

Public import no longer supplies arbitrary HTTPS or DNS to a gVisor workload,
and the Agent/Tool Pod remains completely offline. GitHub hostname or protocol
changes now fail closed and require an explicit policy change. Private
repository import remains a separate trusted GitHub Gateway path and does not
share this public capability.

## Evidence

Unit tests cover the closed proxy bootstrap schema, tenant-free Pod shape,
NetworkPolicy validation and standards-compliant proxy authentication
challenge. The live K3s/runsc gate fetched a pinned public commit through one
audited `github.com` tunnel, returned the expected source without `.git`, and
confirmed no importer Pod remained. The same full gate also passed dependency
installation, final-Pod offline enforcement, clean prewarm consumption,
cross-tenant isolation, fenced warm reuse, pure-chat zero-Pod behavior and a
remote coding repair.
