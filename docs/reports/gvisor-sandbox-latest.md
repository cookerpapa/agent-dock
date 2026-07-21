# gVisor Sandbox evaluation

Measured on 2026-07-21 with:

```bash
npm run sandbox:check
npm run production:check
```

## Environment

| Component | Measured value |
| --- | --- |
| Host | Ubuntu 24.04 under WSL2, Linux `6.6.87.2-microsoft-standard-WSL2` |
| Docker Engine | `29.6.2`, native Linux daemon |
| Docker Compose | `5.1.3` |
| gVisor | `runsc release-20260714.0`, OCI spec `1.2.1` |
| gVisor platform | KVM, fixed in Docker runtime arguments |
| Tool gate image | `sha256:4acafbc5ec77e5750316f9e6fe83a96bfa3d2596fa06ff36c0492bd1349ba65b` |
| Guest-visible kernel | `4.19.0-gvisor` |

## Results

| Gate | Result | Evidence |
| --- | --- | --- |
| gVisor runtime attestation | pass | Docker runtime is `runsc`; live guest kernel contains `gvisor` |
| Host identity concealment | pass | guest does not report the WSL kernel release or physical CPU model |
| Credential and `/proc` isolation | pass | model/platform environment and trusted Runner processes unavailable |
| Network isolation | pass | platform services, host gateway and public Internet unreachable |
| Cross-tenant workspace isolation | pass | separate activation cannot access another workspace |
| Path and symlink confinement | pass | absolute, traversal and symlink-escape probes rejected |
| Output/timeout limits | pass | unbounded output truncated and timed command terminated |
| Process limit | pass | guest `RLIMIT_NPROC=128`; 121 children started and 135 were rejected in the exhaustion probe |
| CPU/memory/disk configuration | pass | inspected limits match the immutable policy |
| Cancellation and cleanup | pass | foreground/background descendants and managed container removed |
| Real Pi remote tools | pass | pinned Pi completed deterministic `bash/edit/bash`, capture and checkpoint flow |
| Production topology | pass | multi-tenant UI/API, restart/fencing, cancellation, observability and encrypted restore drill |
| Managed runtimes after gates | `0` | no labeled Tool or repository-import container remained |

The isolated security contract took approximately 14.1 seconds and the real Pi
remote-tool repair approximately 9 seconds on this host. These timings are
single-run engineering evidence, not a capacity benchmark.

The production acceptance completed with 22 durable test events, four
registered tenants, three Prometheus targets, three Jaeger services, workspace
version 3, 31 product audit events, a 7,360,075-byte encrypted backup and a
successful restore through event cursor 34.

## Boundary statement

This proves the repository's supported local/self-hosted gVisor/KVM execution
path. It does not by itself constitute an independent penetration test or a
claim that the current loopback deployment is ready for hostile public-Internet
SaaS traffic.
