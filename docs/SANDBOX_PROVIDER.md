# Sandbox Provider contract

## Purpose

`SandboxProvider` separates stable AgentDock execution semantics from a concrete
container or microVM API. Pi and the Control Plane never receive a Docker client,
socket, container-create options, host path, or provider SDK object.

The implementation lives in
`packages/sandbox-manager/src/sandbox-provider.ts`. ADR-0030 records the
boundary and ADR-0035 records the stronger Docker microVM implementation.

## Layering

```text
Trusted Pi extension
        |
        | Manager HTTP + activation capability
        v
ToolSandboxManager
  - capability digest and revocation
  - assignment identity and replay checks
  - fixed deployment policy
        |
        | immutable SandboxHandle
        v
SandboxProvider
  - runtime lifecycle and inspection
  - worker transport
  - snapshot and exact cleanup
```

The Manager owns authorization once for every Provider. A Provider never sees
the service credential or bearer capability.

## Contract

The provider-neutral interface contains:

- `create(spec)`;
- `exec(handle, request, signal)`;
- `readFile(handle, input, signal)`;
- `writeFile(handle, input, signal)`;
- `snapshot(handle, requestId)`;
- `stop(handle)`;
- `destroy(handle)`;
- `inspect(handle)`;
- orphan inventory and exact termination operations;
- controlled public-GitHub import;
- `checkHealth()` and `close()`.

`stop` is graceful but still ends with confirmed absence. `destroy` is the
forceful idempotent primitive. Provider shutdown must clean all tracked
activations.

## Immutable handle identity

A handle binds all of the following:

```text
providerId / providerApiVersion
activationId / opaque runtimeId / runtimeName
tenantId / sessionId / turnId / attemptId
supervisorId / bootId / sandboxId
commandId / leaseId / fencingToken
```

The current attempt ID is the execution lease UUID. This is explicit rather
than inferred from a container name. A future `RunAttempt` table can provide a
different UUID while retaining the same Provider contract.

The Docker Provider duplicates the critical identity into labels, then
re-inspects those labels immediately before destructive operations. A caller
cannot stop a runtime through a handle for another tenant, turn, attempt, lease,
or fence.

The Docker microVM Provider retains those labels on the nested Tool Worker and
adds an atomic private host manifest that binds the same identity to the owning
VM. A fresh Manager re-inspects both manifest and inner labels. A VM without a
valid manifest is never guessed from its name or destroyed automatically.

## Policy

The caller does not submit a policy. `ToolSandboxManager` supplies the immutable
deployment policy:

```text
network: deny_all
user: 1000:1000
root filesystem: read-only
privileged: false
capabilities: drop ALL
no-new-privileges: true
host mounts / Docker socket: forbidden
CPU: 1 core
memory: 768 MiB
PIDs: 128
open files: 1024
/tmp: 64 MiB tmpfs
/workspace: 128 MiB tmpfs
tool output: 1 MiB
command timeout: at most 300 seconds
turn wall clock: 900 seconds
```

The network-policy type reserves `github`, `package_registries`, and
`explicit_hosts`, but the Docker Tool Provider currently supports only
`deny_all`. Passing any other policy fails closed. Repository import is a
separate one-shot workload on a dedicated egress bridge; it does not weaken the
Tool Sandbox policy.

## Supported Providers

| Provider | Status | Isolation | Notes |
| --- | --- | --- | --- |
| `docker` | implemented and production-tested | Linux namespaces/cgroups, shared host kernel | supported private single-host deployment |
| `docker_microvm` | implemented and integration-tested | separate LinuxKit microVM kernel plus nested hardened Tool Worker | opt-in Docker Desktop host Manager; higher cold-start/memory cost |
| `docker_gvisor` | planned | OCI `runsc` user-space application kernel | requires compatibility and performance suite |
| `vercel` | planned | Firecracker microVM | outbound network is allowed by default and must be firewalled |

An interface is not evidence that a Provider works. Only implementations that
pass the same lifecycle, security, Pi repair, checkpoint, and production tests
may move to `supported`.

## Adding a Provider

1. Implement the interface without exposing the native SDK in `SandboxHandle`.
2. Map the fixed policy to effective runtime controls and reject unsupported
   fields.
3. Prove tenant/turn/attempt identity on inspect and destroy.
4. Prove cancellation removes descendants and `close()` removes all runtimes.
5. Prove deny-all network behavior from inside the runtime.
6. Run the real Pi remote-tool repair and two-turn checkpoint restore.
7. Add provider-specific failure classification without leaking diagnostics or
   credentials.
8. Add a closed deployment configuration value and production acceptance.

Provider choice is deployment policy. It is not accepted from a prompt, browser
request, tenant setting, or Tool RPC.

## `docker_microvm` mechanics

```text
Sandbox Manager on trusted host
  -> docker sandbox create (pinned shell template)
  -> apply outer proxy policy deny
  -> load exact trusted Tool image archive
  -> inner docker run with the normal hardened arguments
  -> existing Tool Worker JSONL protocol
```

The outer shell is not a user shell. It is a trusted bridge used only for
`docker load`, inner lifecycle, and guest-kernel inspection. The untrusted Tool
Worker has `network=none`, no mount, and no Docker socket. The host staging
directory contains only the trusted image archive and is unlinked immediately
after its image ID is verified inside the VM.

Select it only when the Manager runs on a host with a working Docker Sandboxes
client/server:

```bash
AGENT_DOCK_SANDBOX_PROVIDER=docker_microvm
AGENT_DOCK_MICROVM_STATE_DIRECTORY=/var/lib/agent-dock/microvm
AGENT_DOCK_MICROVM_TEMPLATE_PULL_POLICY=missing
```

The default template is digest-pinned. `always`, `missing`, and `never` are the
only accepted pull policies. If the host needs an upstream proxy, configure it
for the Docker Sandbox daemon before starting the Manager. Proxy values are not
forwarded to the Tool Worker.

Reproduce the complete stronger-provider gate with:

```bash
npm run sandbox-microvm:check
```
