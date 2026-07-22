# ADR-0044: Capability-scoped dependency egress

- Status: Accepted
- Date: 2026-07-22
- Extends: ADR-0042, ADR-0043

## Context

Environment recipes already distinguish offline commands from commands that
need dependency access, but the Tool Worker currently rejects every
`network: dependency` command. Giving a Tool Pod general DNS and Internet
egress would violate the execution-plane boundary: a package lifecycle script
is untrusted code and could scan private addresses, reach platform services or
exfiltrate data to an arbitrary endpoint.

The dependency path therefore needs to be narrower than network membership and
must remain independent of the Pi Agent loop.

## Decision

An immutable environment recipe may declare a sorted set of exact HTTPS
dependency hostnames. A recipe that contains a dependency-network command must
declare at least one host, and a recipe without such a command cannot declare a
host policy.

The Sandbox Manager owns an Ed25519 issuer key outside Kubernetes. For each
physical activation that needs dependency setup it signs a short-lived,
single-purpose capability containing:

- the activation and policy digest;
- the exact allowed hostnames;
- not-before and expiry times;
- connection, byte, concurrency and duration ceilings; and
- a random nonce.

Only the public verification key enters Kubernetes, through a named ConfigMap
that the Manager may patch but not create. The private key is never mounted in
Kubernetes or a Tool Pod.

A dedicated trusted CONNECT proxy runs in `agent-dock-egress` and is also reused
by the separately scoped public-repository import protocol in ADR-0046. Disposable
dependency-bootstrap Pods with an immutable dependency-policy label may
connect only to that proxy. They keep
`dnsPolicy: None`; the proxy, not the Sandbox, resolves dependency names. The
proxy accepts only authenticated CONNECT requests to exact policy hosts on TCP
443. It resolves the name for every connection, connects to the validated IP
rather than resolving again in the socket API, and rejects loopback, private,
link-local, multicast, documentation and other non-public ranges for IPv4 and
IPv6. Redirects naturally require a new CONNECT and therefore a new policy and
DNS check.

The Tool Worker receives the capability over the trusted Kubernetes attach
channel during initialization. Proxy variables are injected only into the
specific environment-recipe command marked `network: dependency`. After each
recipe command exits, the Worker kills the entire detached process group so a
child cannot retain the proxy environment. After setup succeeds, the Manager
captures the Workspace, destroys the exact bootstrap Pod with a UID
precondition, and confirms that it is absent. It then restores the capture into
a brand-new Tool Pod that never had the dependency label or proxy capability.
All verification commands run in this second, deny-all Pod before its handle is
returned to the Agent. Later Agent tools therefore cannot inherit the setup
Pod's network namespace, processes, token or runtime identity, even if a CNI
does not promptly converge an updated label selector.

The token is intentionally a narrow, short-lived network capability; it is not
a platform credential. It may be observed by the untrusted setup command, so
its authority, lifetime and byte/connection ceilings remain bounded while the
temporary network label exists.

## Security invariants

- The Agent/model cannot choose a proxy endpoint, runtime policy, namespace,
  Service, Pod label or capability claims.
- Dependency hosts are exact lowercase DNS names. Wildcards, IP literals,
  ports and URLs are rejected.
- HTTP forwarding, arbitrary methods, non-443 CONNECT, private resolutions and
  unauthenticated requests fail closed.
- Capability values and proxy credentials are never logged, included in Tool
  results, written to Workspace files or persisted as environment-validation
  evidence.
- Ordinary `bash`, `read`, `write`, `edit` and `git` Agent tools remain
  deny-all and are exposed only in the separate never-networked Tool Pod.
  Dependency egress is an environment-setup facility, not interactive shell
  Internet access.
- The proxy has no database, model, object-store, GitHub, Kubernetes or Docker
  credential and cannot enter platform Compose networks.
- Bootstrap Pods never enter Supervisor inventory and are never reused. A used
  Tool Pod remains bound to its exact Session; dependency access does not
  permit cross-tenant Pod reuse.
- Provider startup removes any bootstrap Pod orphaned by a previous Manager
  crash before accepting work.

## Failure behavior

Missing policy, missing proxy, invalid issuer state, expired capability,
quota exhaustion, DNS failure or any non-public answer makes environment
initialization fail. The platform does not silently retry an ambiguous setup
command or fall back to general egress. A failed bootstrap or offline
verification destroys every activation; no partially prepared handle reaches
the Agent.

## Consequences

Owners can install dependencies reproducibly through versioned environment
configuration without connecting arbitrary Agent commands to the Internet.
Exact hostname policies require explicit CDN/registry endpoints and may need a
new environment version when a registry changes infrastructure. This is an
intentional security and audit tradeoff.
