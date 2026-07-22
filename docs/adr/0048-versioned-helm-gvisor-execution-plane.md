# ADR-0048: Versioned Helm gVisor execution plane

- Status: Accepted
- Date: 2026-07-22
- Extends: ADR-0039, ADR-0044, ADR-0045, ADR-0046

## Context

The execution plane was previously one hand-maintained Kubernetes YAML file.
It worked on the validated host, but did not provide a closed configuration
contract, repeatable upgrade behavior or a CI check that an innocent edit had
not changed RuntimeClass, RBAC, network or service exposure.

Rendering Kubernetes objects is necessary but not sufficient evidence. Helm
cannot prove that a real CNI enforces NetworkPolicy, a CSI volume moves between
nodes, or `runsc` is registered correctly on a worker.

## Decision

`deploy/helm/agent-dock-execution-plane` is the sole source of the Kubernetes
execution-plane resources. The chart is versioned independently and has a
closed `values.schema.json`. The following security identities are fixed by the
chart and cannot be selected through values:

```text
RuntimeClass/agent-dock-gvisor -> handler runsc
sandbox node label/toleration
four execution namespaces
ServiceAccounts and scoped RBAC
default-deny and capability-proxy NetworkPolicies
internal-only proxy Service
```

Values may tune bounded runtime overhead, trusted proxy image identity,
resources, replica count from 2 through 20, and trusted-proxy placement. They
cannot disable gVisor, lower proxy replicas below two, allow a non-zero rolling
unavailable count, add network destinations, expose a NodePort/Ingress, grant
RBAC or change Sandbox identities.

The controlled dependency/repository proxy is two replicas by default, uses a
zero-unavailable rolling update, topology spreading, explicit requests/limits,
and a PodDisruptionBudget. It remains a trusted `runc` infrastructure service;
only untrusted Tool/importer Pods select the fixed gVisor RuntimeClass.

The Runner/Supervisor is deliberately absent from the chart. It keeps its
authenticated outbound connection to the Control Plane and no inbound Runner
Service or Ingress is created. The trusted product plane remains the existing
Docker Compose deployment; this chart owns only the Kubernetes execution
boundary.

The installer checksum-pins Helm 3.18.6 and uses Helm's explicit ownership
takeover to migrate the exact former resources. The old static manifest is
removed to prevent two deployment sources from drifting.

## Verification

`npm run helm:check` performs strict linting, renders a fixed release, parses
every object and asserts:

- restricted Pod Security labels on all execution namespaces;
- `runsc` RuntimeClass mapping and sandbox-node scheduling;
- tokenless workload ServiceAccounts and resource-name-limited Manager RBAC;
- no wildcard/Secret/Node permissions;
- default-deny policies and proxy-only setup/import paths;
- blocked private, loopback and metadata egress CIDRs;
- hardened proxy Pod, explicit resources, rolling strategy and PDB;
- ClusterIP-only service and absence of Runner/Ingress resources;
- schema rejection of unsafe replica, rollout and unknown-value overrides.

`npm run sandbox:check` remains the live single-node acceptance gate. A future
multi-node availability claim additionally requires a real external cluster
with the intended CNI, CSI, taints and node failure tests.

The first in-place release takeover was accepted on 2026-07-23. Live reads
through the deliberately scoped Sandbox Manager identity proved that the fixed
`RuntimeClass`, proxy Service/Endpoints and trust ConfigMap are owned by Helm
release `agent-dock-execution-plane`; the Service exposed two distinct ready
proxy Pod UIDs. Eight direct readiness probes returned the same SHA-256 public
key fingerprint as the production capability issuer. The Manager identity was
still forbidden from reading Deployment, PodDisruptionBudget and NetworkPolicy
objects, so live ownership did not expand its least-privilege RBAC.

After the takeover, the full dynamic gate passed five real Manager tests and
two trusted Pi Runner tests. It exercised exact-commit GitHub import, scoped npm
dependency installation followed by a fresh offline Pod, single-consumption
clean prewarming (2,488 ms versus 4,214 ms cold), cross-tenant and resource
isolation, exact cleanup, warm fence rebind, text-only execution with zero Tool
Pods and a remote code repair. A final two-turn production run then consumed
real `deepseek-v4-flash` tokens, reused one physical gVisor Pod with fence 1 to
2, committed two immutable Review Bundles and destroyed the exact assignment.
The redacted evidence is recorded in
`docs/reports/helm-execution-plane-acceptance-latest.md` and
`docs/reports/real-model-acceptance-latest.md`.

## Consequences

The execution boundary is reproducible and upgradeable without weakening the
outbound-only topology. Proxy image rollout no longer requires a planned
availability gap. Operators must install with the fixed release once per
cluster and must still validate the actual runtime/CNI/CSI; a successful Helm
render is not advertised as proof of kernel or multi-node isolation.
