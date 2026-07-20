# Threat model

## Scope and security claim

AgentDock's supported security claim is a private, single-host, multi-tenant
deployment for repositories selected by the deployment owner. Prompts,
model-generated commands, repository files, build scripts, and tool output are
untrusted. The host administrator, deployed images, Control Plane, Trusted Pi
Runner, Model Gateway, Sandbox Manager, PostgreSQL, and object store are trusted.

The current Docker Provider reduces accidental and prompt-driven access to the
platform, but it shares the host kernel. It is not a sufficient boundary for a
hostile public code-execution SaaS.

## Assets

- tenant identity and authorization;
- long-lived model-provider credentials and turn-scoped gateway capabilities;
- Supervisor enrollment/management and Sandbox Manager credentials;
- PostgreSQL control state and tenant usage records;
- S3/MinIO checkpoints, immutable Workspace versions, and repository seeds;
- GitHub App private key, short-lived installation tokens, and repository write authority;
- Pi JSONL conversation history;
- tenant workspace contents and resulting patches;
- the Docker host and its socket.

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
          SandboxProvider
                 v
      Tool Sandbox (untrusted, no GitHub-control network)
```

The Sandbox Manager is deliberately small but highly privileged: compromise of
the process that owns `/var/run/docker.sock` is equivalent to compromise of the
single Docker host. The Trusted Runner does not receive that socket. The Tool
Sandbox receives neither the socket nor any platform credential.

## Adversaries and assumptions

In scope:

- a prompt that persuades the model to run arbitrary shell commands;
- a repository with malicious build/test scripts;
- a tenant probing another tenant's IDs, events, checkpoints, or workspace;
- replayed Tool RPC operations or stale fenced workers;
- runaway output, process creation, memory use, CPU use, and long-running tools;
- Runner, Manager, browser, or network interruption at lifecycle boundaries;
- symlink and lexical path traversal inside a workspace;
- accidental secret disclosure through environment, logs, events, Docker
  configuration, snapshots, or patches.

Assumed trusted or out of scope for the current claim:

- a malicious host administrator or compromised Docker daemon;
- a Docker/kernel/container-runtime escape;
- arbitrary user-supplied Pi extensions running beside model credentials;
- public anonymous hostile tenants, billing abuse, and Internet-scale denial of
  service;
- supply-chain compromise of pinned base images or npm packages.

## Threats and controls

| Threat | Control | Executable evidence |
| --- | --- | --- |
| Tool reads provider or platform credentials | Fixed subprocess environment; no credential env/file/mount in Tool Sandbox | `env`, `/proc/self/environ`, and `/proc/1/environ` probes |
| Tool controls Docker host | Socket exists only in Manager; Tool and Runner have no socket | production topology inspection |
| Tool reaches internal services or Internet | Tool Sandbox uses `network=none`; Manager is not attached to platform/provider/repository egress | six-target TCP denial probe and network matrix |
| Cross-tenant workspace read | One mount-free workspace tmpfs per active turn; immutable identity-bound handle | simultaneous two-tenant integration test |
| Path or symlink escape | lexical root check, parent realpath check, `O_NOFOLLOW`, final-link rejection | traversal and `/etc/passwd` symlink tests |
| Capability theft/replay | random bearer stored only as SHA-256 digest; exact activation binding; operation-ID replay set | Manager unit/integration tests |
| Stale worker commits state | lease ID, attempt ID, fencing token, checkpoint revision CAS, fenced event commit | PostgreSQL and production recovery tests |
| Runaway resource use | Docker cgroups, PID/file limits, tmpfs quotas, command/output/turn bounds | effective inspection and in-container cgroup probes |
| Cancel leaves descendants | process-group abort followed by exact container destroy/absence confirmation | long background-process cancellation test |
| Partial checkpoint becomes current | upload/hash/manifest validation followed by fenced pointer CAS; terminal event is commit marker | checkpoint corruption and two-turn restore tests |
| Old/failed Attempt publishes a Workspace version | staged version is bound to Run/Attempt and settled in the fenced terminal transaction; failures abandon it and restore prior pointers | version consistency and stale-attempt tests |
| GitHub token reaches repository code | only the Gateway owns App key/tokens; private import returns canonical bytes and write-back consumes a trusted artifact | Gateway contract and Tool-Sandbox environment/network tests |
| GitHub webhook forgery/replay | raw-body HMAC verification, bounded normalized schema, service RPC, unique delivery ID and content hash | Gateway HMAC and Control Plane deduplication tests |
| Secret leaks through output | closed public schemas, bounded previews, tenant-scoped full-output Artifacts, no raw Pi payloads, repository secret scan | artifact/event tests, production secret audit, Gitleaks workflow |
| Concurrent model requests overspend one budget | tenant-policy row lock plus completed/unexpired reservation aggregation before provider egress | Model Gateway reservation and denial tests |
| Mutable prices rewrite historical cost | completed request snapshots all four owner-configured rates and integer micro-USD cost | Gateway ledger tests |

## Credential flow

Long-lived provider credentials are decrypted only inside trusted services. A
turn receives a random, expiring Model Gateway capability in the Pi process.
That capability is never forwarded in Tool RPC or environment. The separate
Tool capability authorizes one activation and is stored by the Manager only as
a digest. The Tool Sandbox sees neither capability.

The public repository importer receives no GitHub token. It can fetch only a
normalized public `owner/repository` at an exact commit through its dedicated
egress network. For the optional private path, the GitHub Gateway alone signs
App JWTs and caches short-lived installation tokens in memory. The trusted
Runner receives canonical repository bytes; the Control Plane submits a
tenant/version-validated artifact for delivery. Neither component receives the
token, and the Tool Sandbox cannot route to the Gateway. The default deployment
ships without a usable App private key and fails App operations closed.

## Residual risks and required upgrades

Before exposing arbitrary untrusted repositories to the public Internet:

1. replace or augment shared-kernel Docker with an integration-tested gVisor,
   Kata, Firecracker, or managed microVM Provider;
2. put repository and dependency egress behind a DNS-aware allowlisting proxy;
3. add public identity recovery, broader abuse/rate controls, audit retention,
   and incident response around the existing tenant model budgets;
4. isolate project/user extension code from Pi and model credentials;
5. publish image provenance, SBOM, vulnerability scanning, and patch policy;
6. run an independent penetration review of the Manager and host configuration.

## Reproduction

```bash
npm run sandbox-provider:check
npm run production:check
```

The first command builds the Tool image and runs the Provider plus real Pi
isolation suites without model tokens. The second creates and removes a complete
disposable production topology and tests multi-tenant recovery behavior.
