# Sandbox Provider contract

## Purpose

`SandboxProvider` separates stable AgentDock execution semantics from a concrete
container or microVM API. Pi and the Control Plane never receive a Docker client,
socket, container-create options, host path, or provider SDK object.

The implementation lives in
`packages/sandbox-manager/src/sandbox-provider.ts`. ADR-0030 records the
boundary.

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
