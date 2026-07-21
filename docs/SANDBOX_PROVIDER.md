# gVisor Sandbox Provider

## Supported boundary

AgentDock has exactly one untrusted execution provider:
`GvisorSandboxProvider`. Docker Engine supplies trusted lifecycle operations,
but every Tool Worker and public-repository importer is started explicitly with
the OCI runtime `runsc`. The host config fixes `runsc` to `--platform=kvm`.

There is no provider selector, runc fallback, Docker Desktop fallback, systrap
fallback, LinuxKit microVM path, or managed-provider compatibility branch. A
host that cannot execute a real `runsc` KVM probe is unhealthy and receives no
turns.

ADR-0030 defines the provider-neutral Manager boundary. ADR-0038 supersedes its
original concrete provider and is the current runtime decision.

## Layering

```text
Trusted Pi Runner
    | authenticated Tool RPC + activation capability
    v
ToolSandboxManager
    | authorization, assignment fencing, policy, revocation
    v
GvisorSandboxProvider
    | trusted Docker lifecycle API; explicit runtime=runsc
    v
runsc/KVM Tool Sandbox
    | /workspace, bash/edit/git/test; no platform credential/network
```

Only the Sandbox Manager owns the Docker socket. Pi, the Control Plane and the
Tool Sandbox never receive it or a Docker SDK object. The provider never sees a
Manager bearer credential.

## Provider contract

The interface contains:

- `create`, `exec`, `readFile`, `writeFile` and `snapshot`;
- `stop`, forceful idempotent `destroy`, and `inspect`;
- exact orphan inventory and termination;
- credential-free exact-commit public GitHub import;
- `checkHealth` and `close`.

The exact-commit public repository importer is not a Tool Sandbox. It is a
fixed-purpose, credential-free `runsc` workload on Docker's legacy default
`bridge`, used because the validated WSL/KVM path cannot reach Docker's embedded
DNS on a user-defined bridge. The network name is not configurable. The worker
constructs the GitHub URL itself, disables redirects and hooks, receives no
prompt or platform credential, and never runs repository code. Tool execution
remains strictly `network=none`.

An immutable handle binds provider API version, activation/runtime identity,
tenant, session, turn, attempt, Supervisor boot, command, lease and fencing
token. The provider duplicates that identity into Docker labels and re-inspects
the labels before destructive operations. Cross-assignment handles fail closed.

## Fixed Tool policy

The browser, prompt and tenant cannot choose this policy:

```text
runtime: runsc, platform: KVM
network: deny-all
user: 1000:1000
root filesystem: read-only
privileged: false
capabilities: drop ALL
no-new-privileges: true
host mounts / Docker socket: forbidden
CPU: 1 core
memory: 768 MiB
container PID limit: 128
guest RLIMIT_NPROC: 128
open files: 1024
/tmp: 64 MiB tmpfs
/workspace: 128 MiB tmpfs
tool output: 1 MiB
command timeout: at most 300 seconds
turn wall clock: 900 seconds
```

The guest `RLIMIT_NPROC` is intentional: on the tested gVisor version Docker's
outer cgroup PID value alone did not bound guest-created processes. The live
gate therefore proves actual fork exhaustion rather than only inspecting
configuration.

## Runtime attestation

Manager readiness requires:

1. a native Linux Docker Engine;
2. a registered `runsc` runtime whose arguments contain `--platform=kvm`;
3. the exact Tool image locally present;
4. a real networkless probe whose guest kernel identifies as gVisor.

Every activation is then inspected again. `HostConfig.Runtime` must equal
`runsc`, identity labels must match the handle, no forbidden mount may exist,
and `uname -r` from inside the runtime must identify the gVisor kernel. A config
string without a successful workload is not accepted as evidence.

## Host installation

On supported Ubuntu/WSL2 hosts with nested KVM:

```bash
sudo AGENT_DOCK_HOST_USER="$USER" ./scripts/install-gvisor-host.sh
newgrp docker
npm run sandbox:check
```

See [`deploy/host/README.md`](../deploy/host/README.md). The installer uses the
official Docker and gVisor package repositories, requires `/dev/kvm`, registers
`runsc` with KVM, and executes a direct probe. It never selects a weaker
runtime.

## Acceptance gate

```bash
npm run sandbox:check
```

The gate builds the real Tool image and proves gVisor identity, non-root and
read-only execution, credential and host `/proc` isolation, network denial,
cross-tenant workspace isolation, traversal/symlink rejection, bounded output,
real process/memory/resource limits, cancellation, exact cleanup, checkpoint
capture and a pinned Pi remote-tool repair. The production gate additionally
proves restart, fencing, multi-tenancy and backup recovery:

```bash
npm run production:check
```

The latest measured gVisor result is recorded in
[`reports/gvisor-sandbox-latest.md`](reports/gvisor-sandbox-latest.md).
