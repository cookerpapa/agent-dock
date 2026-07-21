# ADR-0038: gVisor-only untrusted tool execution

Status: Accepted

Date: 2026-07-21

Supersedes: the concrete runtime choices in ADR-0030 and ADR-0035. The
provider-neutral Manager contract from ADR-0030 remains an architectural
boundary, but the supported product has exactly one concrete Provider.

## Context

The original Tool Sandbox used a hardened Docker container. ADR-0035 added an
optional Docker Sandboxes/LinuxKit microVM Provider. Both paths preserved the
trusted Pi Runner / untrusted tool split, but leaving deployment-selectable
runtimes made the production security claim conditional and allowed an
operator mistake to select the shared-host-kernel path.

The product owner has chosen gVisor as the only untrusted execution runtime.
AgentDock therefore needs an executable invariant stronger than a provider
name: every Tool Sandbox and every repository importer must be launched by the
Docker Engine through the `runsc` OCI runtime, and startup must fail if a real
gVisor workload cannot run.

The validated development host is Ubuntu 24.04 under WSL2. With
`runsc release-20260714.0`, the `systrap` platform panics while creating its
syscall thread on this WSL kernel. The KVM platform succeeds through both a
direct `runsc` probe and Docker Engine. The resulting guest-visible kernel is
`4.19.0-gvisor`; the WSL kernel release and physical CPU model are not exposed
through the guest's normal `/proc` and `uname` views.

## Decision

1. `GvisorSandboxProvider` is the only concrete Provider in the supported
   Sandbox Manager. There is no runtime selector and no fallback.
2. The Docker Engine remains the trusted lifecycle/orchestration mechanism,
   but all untrusted Tool Worker and repository-import containers include
   `--runtime=runsc` explicitly. Trusted infrastructure containers do not need
   to run under gVisor.
3. The validated host runtime is `runsc` with `--platform=kvm`. Host setup must
   require a readable/writable `/dev/kvm` and must fail rather than switch to
   `systrap` or `runc`.
4. Manager readiness verifies all of the following before accepting work:

   - a reachable Linux Docker Engine;
   - a registered runtime named `runsc`;
   - the exact Tool image is present;
   - a credential-free, networkless probe actually starts with `runsc` and
     reports a gVisor kernel.

5. Every running activation is inspected again. `HostConfig.Runtime` must be
   `runsc`, and a trusted `docker exec uname -r` probe must report a gVisor
   kernel before the effective-isolation result is accepted.
6. The existing controls remain mandatory: non-root user, read-only root,
   dropped capabilities, no-new-privileges, no host mounts, no Docker socket,
   no network, bounded CPU/memory/PIDs/files/output/time, path confinement,
   fenced identity, cancellation and exact cleanup.
7. The ordinary Docker Provider, Docker Sandboxes microVM Provider, their
   configuration fields, integration gates and runtime-selection branches are
   removed. Historical ADRs and evidence may remain as superseded records, but
   they are not executable product paths.

## Security boundary

gVisor interposes a userspace application kernel between untrusted code and the
host Linux kernel. The KVM platform uses hardware virtualization for the
Sentry's address-space implementation. It materially reduces direct host-kernel
syscall exposure compared with an ordinary container, but it is not a
Firecracker-style full guest operating system and does not eliminate risk in
runsc, KVM, Docker Engine or the host kernel.

The Sandbox Manager still holds root-equivalent Docker socket authority and is
trusted. Pi, model credentials, PostgreSQL, object storage and internal service
credentials remain outside the Tool Sandbox. This decision does not by itself
authorize public Internet exposure, arbitrary project extensions or unrestricted
network egress.

## Consequences

- A host without working `runsc`/KVM cannot start the Sandbox Manager.
- There is no lower-security availability fallback.
- Tool startup and syscall/file-heavy workloads pay gVisor overhead.
- Some Linux software may be incompatible with gVisor and must fail visibly or
  be added only after a compatibility test.
- WSL2 is suitable for this local self-hosted demonstration only because the
  exact KVM path is tested. A public deployment still requires a separate host
  and threat review.

## Acceptance evidence

The gVisor gate must build the Tool image and prove:

1. startup fails when `runsc` is absent;
2. every activation and importer records Docker runtime `runsc`;
3. guest kernel identity contains `gvisor` and not the host kernel release;
4. credentials, platform `/proc`, Docker socket, internal networks, public
   network and another tenant's workspace are unavailable;
5. path/symlink escape, unbounded output and overlong commands fail closed;
6. CPU, memory, PID, workspace and file-descriptor limits are effective;
7. cancellation removes foreground and background processes;
8. real pinned-Pi `bash/edit/bash`, checkpoint restore and final cleanup still
   pass;
9. the complete production topology starts only after Manager readiness and
   leaves no managed gVisor container after terminal turns.
