# Kubernetes gVisor execution-plane evaluation

Measured on 2026-07-21 with:

```bash
npm run sandbox:check
npm run production:check
AGENT_DOCK_LIVE_GITHUB_CHECK=1 npm run production:github-check
```

## Environment

| Component | Measured value |
| --- | --- |
| Host | Ubuntu 24.04 under WSL2, Linux `6.6.87.2-microsoft-standard-WSL2` |
| Trusted product plane | Docker Engine `29.6.2`, Compose `5.1.3` |
| Kubernetes | K3s `v1.36.2+k3s1` |
| Container runtime | embedded containerd `2.3.2-k3s2` |
| gVisor | `runsc release-20260714.0`, OCI spec `1.2.1` |
| Runtime mapping | `RuntimeClass/agent-dock-gvisor -> io.containerd.runsc.v1` |
| gVisor configuration | `platform=kvm`, `network=sandbox`, host/software GSO disabled |
| Tool gate image | `sha256:a5962cc849e9d5084d63039ca09aea3452c9a80e23e246d9d04ddf622884b1f6` |
| Guest-visible kernel | `4.19.0-gvisor` |

## Results

| Gate | Result | Evidence |
| --- | --- | --- |
| Kubernetes control path | pass | official client creates Pods through scoped API; Manager has no Docker/containerd socket |
| gVisor runtime attestation | pass | named RuntimeClass handler is `runsc`; live Pod kernel contains `gvisor` |
| RBAC/admission boundary | pass | only two execution namespaces plus one named RuntimeClass read; Secret/list-RuntimeClass denied |
| Host identity concealment | pass | guest does not report the WSL kernel release or physical CPU model |
| Credential and `/proc` isolation | pass | model/platform environment and trusted Runner processes unavailable |
| Network isolation | pass | platform services, host gateway and public Internet unreachable |
| Exact-commit import | pass | restricted importer fetched/checksummed a real public GitHub commit and left no Pod |
| Cross-tenant workspace isolation | pass | separate activation cannot access another workspace |
| Path and symlink confinement | pass | absolute, traversal and symlink-escape probes rejected |
| Output/timeout limits | pass | unbounded output truncated and timed command terminated |
| Process limit | pass | guest `RLIMIT_NPROC=128`; 121 children started and 135 were rejected in the exhaustion probe |
| CPU/memory/disk configuration | pass | inspected limits match the immutable policy |
| Cancellation and cleanup | pass | foreground/background descendants and UID-fenced Pod removed |
| Real Pi remote tools | pass | pinned Pi completed deterministic `bash/edit/bash`, capture and checkpoint flow |
| Real GitHub + model flow | pass | exact commit imported, two DeepSeek turns restored one Workspace, ran tools and persisted usage |
| Production topology | pass | multi-tenant UI/API, restart/fencing, cancellation, observability and encrypted restore drill |
| Managed runtimes after gates | `0` | neither execution namespace retained a managed Pod |

The final complete gate measured 8.032 seconds for exact-commit import, 19.569
seconds for the isolated security contract, and 12.754 seconds for the real Pi
remote-tool repair on this host. Two subsequent focused importer runs measured
54.566 and 8.311 seconds. The slower run exercised the bounded recovery path in
practice: its first Git connection hit the 45-second attempt deadline and the
next fresh connection completed. These are single-host engineering
measurements, not capacity SLOs.

The first import experiments found two reproducible host/runtime compatibility
failures: default HTTP/2 produced a Git `curl 16` framing error, while the first
HTTP/1.1 pack request could stall for 30 seconds with segmentation offload.
Keeping gVisor `network=sandbox`, disabling host/software GSO, pinning importer
Git to HTTP/1.1, and trusting only fixed `/workspace` ownership removed those
reproducible baseline failures. Because a later public-network connection still
hit a transient stall, exact-commit fetch now also uses a 20-second low-speed
threshold, a 45-second per-attempt deadline and at most three attempts within
the existing 180-second importer lifetime. The gate performs the real fetch on
every explicit run.

The production acceptance completed with 22 durable test events, four
registered tenants, three Prometheus targets, three Jaeger services, workspace
version 3, 31 product audit events, a 7,362,269-byte encrypted backup and a
successful restore through event cursor 34.

The opt-in live gate imported
`mathewjonas/java-calculator-junit@0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb`,
then completed two turns in one Session. The turns emitted 413/254 events,
started 23/7 tools and produced cumulative patches of 3,628/5,204 bytes. The
immutable 13,904-byte source snapshot was reused without a second import. The
ledger recorded 22 real `deepseek-v4-flash` calls, 6,468 input tokens, 5,490
output tokens, 145,408 cache-read tokens and zero cache-write tokens. Both
managed execution namespaces were empty after settlement.

## Boundary statement

This proves the repository's supported local/self-hosted Kubernetes +
gVisor/KVM execution path. Kubernetes provides API-mediated placement,
lifecycle, cgroups, admission and network policy; gVisor provides the reduced
syscall boundary. It does not by itself constitute an independent penetration
test or a claim that the current single-node loopback deployment is ready for
hostile public-Internet SaaS traffic.
