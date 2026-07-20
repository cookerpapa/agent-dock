# ADR-0035: Docker Sandboxes microVM Provider

Status: accepted, 2026-07-20.

## Context

The default Docker Provider has a narrow Tool RPC boundary, no network, no
credentials, and effective cgroup/namespace controls, but the untrusted process
still shares the host kernel. Milestone 6 requires a second Provider to pass the
same Tool Worker, lifecycle, cancellation, snapshot, reconciliation, and real
Pi path behind a stronger kernel boundary.

The development host is Docker Desktop on Windows/WSL2. It has no `runsc`
binary or registered gVisor runtime, and Docker Desktop does not provide a
supported persistent custom-OCI-runtime path for this environment. A gVisor
class that could only run against a mocked CLI would not satisfy ADR-0030.
Docker Sandboxes v0.12.0 is installed on this host and provides one LinuxKit
microVM with a separate kernel and Docker Engine per sandbox.

## Decision

1. Add the opt-in `docker_microvm` Provider. `docker` remains the default and
   the supported containerized single-host production topology.
2. Run the Sandbox Manager for this Provider on the trusted Linux/WSL host. It
   invokes the Docker Sandboxes CLI; neither the Pi Runner nor the untrusted
   Tool Worker receives the host transport.
3. Use a short `admv-<activation UUID without hyphens>` runtime name. Docker
   Desktop creates AF_UNIX paths below the VM state directory, so the longer
   descriptive name exceeded the Windows socket-path limit in the first real
   probe.
4. Resolve the trusted Tool image to a host image ID, export it to a private
   content-keyed cache, expose only that archive through a per-activation
   staging directory, load it into the microVM-local Docker Engine, and verify
   the loaded tag resolves to the exact host image ID.
5. Treat the outer `shell` container as a trusted provisioning bridge only. It
   receives no prompt, repository, model credential, Tool capability, or user
   command. Immediately after VM creation, set its proxy policy to deny-all.
6. Start the existing Tool Worker as a nested container inside the microVM with
   the unchanged policy: UID/GID 1000, read-only root, `network=none`, no
   mounts/socket, dropped capabilities, `no-new-privileges`, CPU/memory/PID/file
   limits, and bounded tmpfs workspace. Agent-generated operations cross the
   existing worker JSONL protocol.
7. Persist a private, atomic manifest binding the activation, tenant, Run
   Attempt, lease, fence, VM name, and inner labeled container ID. On Manager
   restart, inventory re-inspects the inner labels before returning an
   assignment. Missing workers cause their exactly identified VM to be cleaned;
   unknown VMs without a valid manifest fail closed.
8. Keep controlled GitHub import on the existing credential-free, one-shot host
   Docker importer. It is a trusted provisioning workload and is not executed
   by the untrusted Tool Worker.
9. Pin the default Docker shell template by digest. Provider choice and template
   override remain trusted deployment configuration, never tenant or prompt
   input.

## Data path

```text
Trusted Sandbox Manager (host)
  -> Docker Sandboxes daemon
     -> LinuxKit microVM (separate kernel, proxy deny-all)
        -> trusted shell/provisioning bridge (microVM-local Docker socket)
           -> hardened Tool Worker container
              -> /workspace tmpfs + bash/edit/git/test
              -> no socket, network, mount, or credential
```

The public `SandboxHandle` remains Provider-neutral. Its opaque runtime ID is
the inner, label-bound container ID required by the existing Supervisor
protocol; its runtime name identifies the owning microVM. Native Docker
Sandboxes objects never cross the Manager boundary.

## Bootstrap exception

Docker Sandboxes may need registry access while installing the pinned trusted
shell template. This occurs before any untrusted Tool Worker or tenant content
exists. The only mounted file is the trusted Tool-image archive. The Provider
then commits deny-all policy before loading or starting the worker. An operator
behind an upstream proxy must configure that proxy where the sandbox daemon
starts; the Provider never puts proxy credentials in the VM or Tool Worker.

## Consequences

- The Tool Worker sees a LinuxKit kernel distinct from the WSL2 host kernel,
  while retaining the same remote-tool and checkpoint behavior.
- Cancellation remains process-group termination inside the worker followed by
  inner-container removal and confirmed VM destruction.
- A microVM per active turn has materially higher cold-start, memory, and disk
  overhead than the default Provider. It is an explicit security/capacity
  tradeoff, not the default for private local use.
- Docker Sandboxes v0.12.0 is a host integration, so the current Compose Manager
  image cannot select this Provider. The runbook supplies a host-manager mode;
  the normal Compose deployment remains `docker`.
- This stronger boundary removes the shared-host-kernel property for Tool code,
  but does not by itself establish a hostile public-SaaS claim. Public identity,
  abuse controls, dependency egress, capacity admission, patch cadence, and an
  independent security review remain separate requirements.

## Evidence

`npm run sandbox-microvm:check` builds the Tool image and runs:

1. the Provider security/lifecycle suite, including deny-all, credentials,
   file/path controls, cancellation, snapshot, fresh-Manager inventory, exact
   termination, and leak-free cleanup;
2. pinned Pi's deterministic Java repair through `bash/edit/bash` and the same
   remote Tool RPC boundary.

The gate is opt-in because it requires Docker Desktop's Docker Sandboxes plugin,
several GiB of free host memory, and a longer microVM cold start.
