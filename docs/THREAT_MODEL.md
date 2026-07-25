# Threat model

## Scope and security claim

AgentDock's supported security claim is a private, single-node, multi-tenant
deployment for repositories selected by the deployment owner. Prompts,
model-generated commands, repository files, build scripts, and tool output are
untrusted. The host administrator, deployed images, Control Plane, Trusted Pi
Runner, Model Gateway, Sandbox Manager, Cube control/compute plane, PostgreSQL,
and object store are trusted.

Ordinary Tool workloads run in independent CubeSandbox KVM guests. Public
repository import remains a separate fixed-purpose gVisor `runsc`/KVM workload.
Neither path is an ordinary shared-kernel Docker-container boundary. This does
not make the current loopback product a hostile public code-execution SaaS:
public identity, abuse controls, Cube control-plane hardening, capacity
admission, arbitrary dependency egress and independent review remain outside
the claim.

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
- Cube API/scheduler/compute state, KVM, the Kubernetes importer node,
  K3s/containerd, `runsc`, and the host kernel.

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
          |      |                                      (trusted credential boundary)
          |      `---- fixed CONNECT ---- Provider egress relay
          |                                  (no model credential)
       capability-scoped Tool RPC
          v
       Sandbox Manager (trusted TCB)
          |                         |
 fixed CubeAPI/Proxy relays     scoped Kubernetes API
          v                         v
 CubeMaster/Cubelet/KVM       gVisor importer Pod
          |
 Tool microVM (untrusted, deny-all outbound)
```

The Sandbox Manager is deliberately small. It holds the CubeAPI key and a
least-privilege Kubernetes credential only for the importer. Fixed-target
credential-free relays prevent request-controlled Cube destinations. The
Manager can create/inspect/delete restricted importer Pods but cannot read
Secrets, mutate RBAC/NetworkPolicy, use host namespaces or manage nodes. No
application service receives a Docker/containerd socket. Tool guests receive
neither a Kubernetes ServiceAccount token, CubeAPI key nor any platform
credential.

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

- a malicious host administrator or compromised Cube/K3s control plane;
- a CubeShim/RustVMM/KVM, gVisor, Kubernetes-node runtime or host-kernel escape;
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
| Runner's provider route exposes host networking or arbitrary egress | Runner joins internal model egress only; a TCP-to-Unix-socket relay permits exact provider TCP/443, holds no model key and does not terminate TLS | production topology inspection, relay allowlist tests and real-provider acceptance |
| Tool controls execution infrastructure | no application has a Docker/containerd socket; Tool guest has no Kubernetes/Cube credential; Cube lifecycle is available only through the bounded Manager and fixed relays | production topology, Cube request-shape tests, live guest credential probes |
| Accepted Run silently changes Tool image after rollout | append-only Project environment versions; immutable Run snapshot; Manager profile/revision match; in-guest toolchain preflight; READY template evidence binds Git revision, image digest and spec hash | migration/protocol tests, production startup gate, Cube environment evidence and real-token Run |
| Model chooses an unreviewed image or runtime policy | template/profile/network/resources remain operator configuration and closed protocols reject extra client fields | protocol schemas, template contract tests and Manager policy mismatch tests |
| Ordinary Tool reaches internal services or Internet | every Cube create request disables Internet/public traffic; guest probes require CubeAPI, platform endpoints and public addresses to fail; dependency-network recipes are rejected | live Cube endpoint/public TCP probes, offline Bash, and network matrix |
| Cross-tenant workspace read | one newly created microVM per exact tenant/project/workspace/session/RunAttempt; immutable handle, rotating capability, full Cube metadata and fence checks | simultaneous two-tenant same-path canaries and Cube KVM gate |
| A used runtime is sanitized and reassigned to another tenant | Cube prewarm/rebind is disabled; every settled, failed, cancelled or timed-out guest is destroyed and later Runs cold-restore an external checkpoint | Provider no-warm tests, exact cleanup and zero-orphan inventory gate |
| Path or symlink escape | lexical root check, parent realpath check, `O_NOFOLLOW`, final-link rejection | traversal and `/etc/passwd` symlink tests |
| Capability theft/replay | random bearer stored only as SHA-256 digest; exact activation binding; operation-ID replay set | Manager unit/integration tests |
| Stale worker commits state | lease ID, attempt ID, fencing token, checkpoint revision CAS, fenced event commit | PostgreSQL and production recovery tests |
| Runaway resource use | Cube template CPU/memory/disk limits plus guest `RLIMIT_NPROC`, file limits and command/output/Turn bounds | template fingerprint, actual process exhaustion and in-guest probes |
| Cancel leaves descendants | process-group abort followed by exact Cube activation destruction and absence confirmation | long background-process cancellation and zero-orphan test |
| Partial checkpoint becomes current | upload/hash/manifest validation followed by fenced pointer CAS; terminal event is commit marker | checkpoint corruption and two-turn restore tests |
| Old/failed Attempt publishes a Workspace version | staged version is bound to Run/Attempt and settled in the fenced terminal transaction; failures abandon it and restore prior pointers | version consistency and stale-attempt tests |
| GitHub token reaches repository code | only the Gateway owns App key/tokens; private import returns canonical bytes and write-back consumes a trusted artifact | Gateway contract and Tool-Sandbox environment/network tests |
| GitHub webhook forgery/replay | raw-body HMAC verification, bounded normalized schema, service RPC, unique delivery ID and content hash | Gateway HMAC and Control Plane deduplication tests |
| Secret leaks through output | closed public schemas, bounded previews, tenant-scoped full-output Artifacts, no raw Pi payloads, repository secret scan | artifact/event tests, production secret audit, Gitleaks workflow |
| Concurrent model requests overspend one budget | tenant-policy row lock plus completed/unexpired reservation aggregation before provider egress | Model Gateway reservation and denial tests |
| Mutable prices rewrite historical cost | completed request snapshots all four owner-configured rates and integer micro-USD cost | Gateway ledger tests |
| Observability leaks tenant content or credentials | closed low-cardinality metric labels, opaque trace attributes, recursive structured-log redaction, separate metrics bearer | observability unit tests and production target inspection |
| Untrusted Tool syscalls attack the host kernel | ordinary Tool code runs behind a distinct KVM guest kernel; no runc/local-process fallback exists | Cubelet/KVM gate, guest/host kernel identity comparison and real Pi tests |
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
The Pod has no DNS and its NetworkPolicy permits only the capability proxy
ClusterIP. A per-import Ed25519 capability fixes the only CONNECT target to
`github.com:443` and bounds lifetime, connections, concurrency, bytes and
duration; proxy resolution rejects private, link-local, Pod, Service and node
addresses. For the optional private path, the GitHub Gateway alone signs
App JWTs and caches short-lived installation tokens in memory. The trusted
Runner receives canonical repository bytes; the Control Plane submits a
tenant/version-validated artifact for delivery. Neither component receives the
token, and the Tool Sandbox cannot route to the Gateway. The default deployment
ships without a usable App private key and fails App operations closed.

The trusted Model Gateway receives the provider key but no host network. Its
public HTTPS request uses Node's environment-aware proxy dispatcher to reach a
private bridge, which forwards to a Unix-socket-only host relay. The relay
accepts only the operator-owned DeepSeek hostname on TCP/443 and transports
opaque TLS bytes; it never receives the request headers inside TLS or the model
key. Cube Tool guests cannot route to Compose networks. The host relay is trusted
transport code and its host-network blast radius is constrained by non-root
execution, no TCP listener, no platform secrets, dropped capabilities,
read-only rootfs and bounded resources.

## Residual risks and required upgrades

Before exposing arbitrary untrusted repositories to the public Internet:

1. move Cube from the validated single-node WSL2/KVM profile to dedicated
   control/compute nodes and complete node-loss, storage, upgrade, density and
   security review;
2. add verified identity, password recovery/MFA, distributed login and
   registration abuse/rate controls, audit retention, and incident response
   around the existing tenant model budgets;
3. isolate project/user extension code from Pi and model credentials;
4. add signed provenance attestations and automated patch cadence on top of the
   current OCI labels, CycloneDX SBOMs, and vulnerability gate;
5. run an independent penetration review of the Manager and host configuration.

The observability backends remain on an internal Compose network. A separate
read-only Caddy process joins that network and its own non-platform edge network,
publishing Prometheus, Jaeger, and Grafana only on host loopback. It has no
platform secret, database network, Kubernetes credential, or Tool-Pod authority.

## Reproduction

```bash
npm run sandbox:check
npm run cubesandbox:live-check
npm run production:check
npm run release:evidence
```

The first command retains the gVisor importer/regression proof. The second
attests real Cube KVM guests, two-tenant isolation, deny-all egress,
cancellation and cleanup. The third creates and removes a deterministic
disposable topology, tests multi-tenant behavior, and restores a coordinated
encrypted backup before continuing a Run. The fourth produces checksummed SBOM
and image vulnerability evidence from clean revision-labelled images.
