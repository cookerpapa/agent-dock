# Threat model

## Scope and security claim

AgentDock's supported security claim is a private, single-node, multi-tenant
deployment for repositories selected by the deployment owner. Prompts,
model-generated commands, repository files, build scripts, and tool output are
untrusted. The host administrator, deployed images, Control Plane, Trusted Pi
Runner, Model Gateway, Sandbox Manager, PostgreSQL, and object store are trusted.

All untrusted tool and public-repository import workloads use gVisor `runsc`
with the KVM platform. This interposes a userspace application kernel and
materially reduces direct host-kernel syscall exposure compared with ordinary
containers. It does not make the current loopback product a hostile public
code-execution SaaS: public identity, abuse controls, dependency egress,
capacity admission, patch operations and independent review remain outside the
claim.

## Assets

- tenant identity and authorization;
- browser password verifiers and revocable Web-session digests;
- long-lived model-provider credentials and turn-scoped gateway capabilities;
- Supervisor enrollment/management and Sandbox Manager credentials;
- PostgreSQL control state and tenant usage records;
- S3/MinIO checkpoints, immutable Workspace versions, and repository seeds;
- GitHub App private key, short-lived installation tokens, and repository write authority;
- Pi JSONL conversation history;
- tenant workspace contents and resulting patches;
- encrypted coordinated backups and their independently stored passphrases;
- the Kubernetes node, K3s control plane/containerd, `runsc`, and host kernel.

## Trust zones

```text
Untrusted browser input / repository / model output
                 |
                 v
        Control Plane (trusted)
                 |
       authenticated commands/events
                 v
   Trusted Pi Runner + Model Gateway ---- service RPC ---- GitHub Gateway
                 |                                      (trusted credential boundary)
       capability-scoped Tool RPC
                 v
       Sandbox Manager (trusted TCB)
                 |
       scoped Kubernetes API
                 v
       K3s/containerd/runsc
                 |
      Tool Pod (untrusted, default-deny network)
```

The Sandbox Manager is deliberately small and holds a least-privilege
Kubernetes credential. It can create/exec/delete restricted Pods and inspect
NetworkPolicy in the two execution namespaces, plus read the one named gVisor
RuntimeClass, but cannot read Secrets, mutate RBAC/NetworkPolicy, use host
namespaces or manage nodes. No application service receives a Docker or
containerd socket. Tool Pods receive neither a ServiceAccount token nor any
platform credential.

## Adversaries and assumptions

In scope:

- a prompt that persuades the model to run arbitrary shell commands;
- a repository with malicious build/test scripts;
- a tenant probing another tenant's IDs, events, checkpoints, or workspace;
- replayed Tool RPC operations or stale fenced workers;
- runaway output, process creation, memory use, CPU use, and long-running tools;
- Runner, Manager, browser, or network interruption at lifecycle boundaries;
- symlink and lexical path traversal inside a workspace;
- accidental secret disclosure through environment, logs, events, Pod
  configuration, snapshots, or patches.

Assumed trusted or out of scope for the current claim:

- a malicious host administrator or compromised K3s/containerd control plane;
- a gVisor, KVM, Kubernetes-node runtime or host-kernel escape;
- arbitrary user-supplied Pi extensions running beside model credentials;
- public anonymous hostile tenants, billing abuse, and Internet-scale denial of
  service;
- supply-chain compromise of pinned base images or npm packages.

## Threats and controls

| Threat | Control | Executable evidence |
| --- | --- | --- |
| Password or browser session disclosure | Per-account salted scrypt verifier; opaque HttpOnly/SameSite session; digest-only persistence; bounded lifetime and immediate revocation | PostgreSQL account/login/logout and cookie-auth integration tests |
| Product user replaces or reads the platform model key | Product UI has no model controls; production writes require the platform-operator tenant; per-tenant AES-GCM binding and safe metadata-only reads | platform-model inheritance/write-denial integration test and production account flow |
| Tool reads provider or platform credentials | Fixed subprocess environment; no credential env/file/mount in Tool Sandbox | `env`, `/proc/self/environ`, and `/proc/1/environ` probes |
| Tool controls execution infrastructure | no application has a Docker/containerd socket; Tool Pod has no ServiceAccount token; Manager RBAC is namespace-scoped except read-only access to the one named RuntimeClass | production topology, RBAC and Pod-spec inspection |
| Tool reaches internal services or Internet | Tool namespace has default-deny ingress/egress and DNS disabled | cluster/service/node/public TCP denial probe and network matrix |
| Cross-tenant workspace read | one memory-backed workspace per exact tenant/project/workspace/session activation; warm reuse never crosses that key; immutable handle, rotating capability and Pod UID/fence checks | simultaneous two-tenant and warm-rebind integration tests |
| Path or symlink escape | lexical root check, parent realpath check, `O_NOFOLLOW`, final-link rejection | traversal and `/etc/passwd` symlink tests |
| Capability theft/replay | random bearer stored only as SHA-256 digest; exact activation binding; operation-ID replay set | Manager unit/integration tests |
| Stale worker commits state | lease ID, attempt ID, fencing token, checkpoint revision CAS, fenced event commit | PostgreSQL and production recovery tests |
| Runaway resource use | Kubernetes resource limits/cgroups plus guest `RLIMIT_NPROC`, file limits, memory-backed volume quotas and command/output/Turn bounds | effective Pod inspection, actual fork exhaustion and in-guest probes |
| Cancel leaves descendants | process-group abort followed by UID-preconditioned Pod deletion/absence confirmation | long background-process cancellation test |
| Partial checkpoint becomes current | upload/hash/manifest validation followed by fenced pointer CAS; terminal event is commit marker | checkpoint corruption and two-turn restore tests |
| Old/failed Attempt publishes a Workspace version | staged version is bound to Run/Attempt and settled in the fenced terminal transaction; failures abandon it and restore prior pointers | version consistency and stale-attempt tests |
| GitHub token reaches repository code | only the Gateway owns App key/tokens; private import returns canonical bytes and write-back consumes a trusted artifact | Gateway contract and Tool-Sandbox environment/network tests |
| GitHub webhook forgery/replay | raw-body HMAC verification, bounded normalized schema, service RPC, unique delivery ID and content hash | Gateway HMAC and Control Plane deduplication tests |
| Secret leaks through output | closed public schemas, bounded previews, tenant-scoped full-output Artifacts, no raw Pi payloads, repository secret scan | artifact/event tests, production secret audit, Gitleaks workflow |
| Concurrent model requests overspend one budget | tenant-policy row lock plus completed/unexpired reservation aggregation before provider egress | Model Gateway reservation and denial tests |
| Mutable prices rewrite historical cost | completed request snapshots all four owner-configured rates and integer micro-USD cost | Gateway ledger tests |
| Observability leaks tenant content or credentials | closed low-cardinality metric labels, opaque trace attributes, recursive structured-log redaction, separate metrics bearer | observability unit tests and production target inspection |
| Untrusted syscalls attack the host-kernel surface | RuntimeClass maps every untrusted Pod to `runsc`/KVM; readiness and activations attest a real gVisor kernel; no fallback exists | RuntimeClass/handler check, guest/host identity comparison and real Pi tests |
| Backup is tampered with, partially restored, or overwrites live state | AES-GCM authenticated payload, scrypt key derivation, per-authority hashes, safe archive paths, exact image IDs, new empty project/runtime only | crypto tamper/wrong-key check and complete production restore drill |
| Repository or Artifact preview executes active content in the browser | React-escaped bounded UTF-8 text only; binary is labelled; no HTML/script/live-preview embedding | Web component/API tests and production bundle/product flow |
| Fixable severe image vulnerability ships unnoticed | immutable-pinned scanner, complete HIGH/CRITICAL report, CycloneDX SBOM, zero-fixable-HIGH/CRITICAL gate | CI image matrix and local release-evidence command |

## Credential flow

Long-lived provider credentials are decrypted only inside trusted services. A
turn receives a random, expiring Model Gateway capability in the Pi process.
That capability is never forwarded in Tool RPC or environment. The separate
Tool capability authorizes one activation and is stored by the Manager only as
a digest. The Tool Sandbox sees neither capability.

The public repository importer receives no GitHub token. It can fetch only a
normalized public `owner/repository` at an exact commit from a fixed-purpose
gVisor Pod in `agent-dock-importers`. It has no host mount, ServiceAccount token,
published port, prompt, user-controlled command, or enabled repository hook.
NetworkPolicy permits cluster DNS and public TCP/443 while excluding private,
link-local, Pod, Service and node ranges; it is not claimed as a DNS-aware
domain firewall. For the optional private path, the GitHub Gateway alone signs
App JWTs and caches short-lived installation tokens in memory. The trusted
Runner receives canonical repository bytes; the Control Plane submits a
tenant/version-validated artifact for delivery. Neither component receives the
token, and the Tool Sandbox cannot route to the Gateway. The default deployment
ships without a usable App private key and fails App operations closed.

## Residual risks and required upgrades

Before exposing arbitrary untrusted repositories to the public Internet:

1. complete a production gVisor/KVM capacity and security review on the actual
   Linux host rather than relying on the validated WSL2 demonstration host;
2. put repository and dependency egress behind a DNS-aware allowlisting proxy;
3. add verified identity, password recovery/MFA, distributed login and
   registration abuse/rate controls, audit retention, and incident response
   around the existing tenant model budgets;
4. isolate project/user extension code from Pi and model credentials;
5. add signed provenance attestations and automated patch cadence on top of the
   current OCI labels, CycloneDX SBOMs, and vulnerability gate;
6. run an independent penetration review of the Manager and host configuration.

The observability backends remain on an internal Compose network. A separate
read-only Caddy process joins that network and its own non-platform edge network,
publishing Prometheus, Jaeger, and Grafana only on host loopback. It has no
platform secret, database network, Kubernetes credential, or Tool-Pod authority.

## Reproduction

```bash
npm run sandbox:check
npm run production:check
npm run release:evidence
```

The first command attests the gVisor/KVM boundary and runs the real Pi remote
tool path. The second creates and removes a complete disposable production
topology, tests multi-tenant behavior, and restores a coordinated encrypted
backup before continuing a Run. The third produces checksummed SBOM and image
vulnerability evidence from clean revision-labelled images.
