# Strong Sandbox Provider selection — 2026-07-20

## Question

Which second Provider can be implemented and exercised honestly on the current
Docker Desktop/WSL2 development host, while preserving PiCloud's existing
Runner/Manager/Tool boundary?

## Candidates

| Candidate | Current-host result | Decision |
| --- | --- | --- |
| Docker + gVisor `runsc` | Docker supports alternative runtimes when the shim/runtime is installed on the daemon host, but this Docker Desktop/WSL2 daemon has no `runsc` and no supported persistent custom-runtime installation path | retain as a Linux-host future Provider; do not mock or claim it |
| Vercel Sandbox | documented Firecracker isolation and firewall controls, but no project credential was available for a real lifecycle/cancellation/checkpoint gate | retain as a future managed Provider; do not claim it |
| Docker Sandboxes | v0.12.0 client/server is installed; one separate LinuxKit microVM/kernel and inner Docker Engine per sandbox; real create/exec/network/stop/remove works | implement as `docker_microvm` |

Primary sources:

- [Docker Sandboxes architecture](https://docs.docker.com/ai/sandboxes/architecture/)
- [Docker Sandboxes isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)
- [Docker Sandboxes local network policy](https://docs.docker.com/ai/sandboxes/governance/local/)
- [Docker Sandboxes troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)
- [Docker alternative container runtimes](https://docs.docker.com/engine/daemon/alternative-runtimes/)
- [gVisor Docker quick start](https://gvisor.dev/docs/user_guide/quick_start/docker/)
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)

## Real-probe findings

1. The Docker Sandbox daemon has a separate network path from the normal Docker
   Engine. The host Engine proxy did not automatically fix its image pull.
2. The daemon must inherit `HTTP_PROXY`/`HTTPS_PROXY` at startup. On this host,
   its loopback upstream was also rejected by the sandbox private-address
   policy, so the local validation used an ephemeral host-only relay on an
   existing globally scoped interface. This is a workstation constraint, not
   PiCloud product logic.
3. The first VM attempt failed with Windows error 1450 because fewer than 4 GiB
   of physical memory was available. Reclaiming WSL page cache provided enough
   headroom. Capacity admission must account for VM memory, not only inner
   container cgroups.
4. A long VM name failed because Docker Desktop creates an AF_UNIX transport
   path under the VM directory. Short, opaque managed names avoid this platform
   path limit.
5. A live sandbox reported guest kernel `6.12.67-linuxkit`; the WSL2 host
   reported `6.6.87.2-microsoft-standard-WSL2`.
6. After `--policy deny`, requests to `example.com` and the host Docker endpoint
   were blocked and recorded in the Docker Sandbox network log.
7. The standard shell template exposes only `proxy-managed` placeholder model
   variables in its trusted bridge. PiCloud never executes user commands in
   that bridge. The nested Tool Worker receives the existing fixed safe
   environment and no model/platform credential.

## Resulting boundary

The Provider nests the already-tested hardened Tool Worker inside the microVM
rather than replacing it with an unrestricted shell:

```text
sandboxd -> LinuxKit VM -> trusted provisioning bridge -> hardened Tool Worker
```

This preserves cgroup/PID/tmpfs/read-only-root controls and the worker's secure
path/cancellation protocol while adding a distinct kernel around untrusted code.
It also avoids giving user commands the microVM-local Docker socket.

## Honest limitations

- Docker Sandboxes v0.12.0 is an opt-in Docker Desktop host integration, not a
  portable in-container daemon API.
- VM-level CPU/memory sizing is not exposed by the current CLI. PiCloud
  enforces the requested limits on the nested worker and treats VM capacity as
  deployment admission overhead.
- MicroVM cold start is much slower than the shared-kernel Docker Provider.
- The selected Provider does not make anonymous public execution safe by
  itself; dependency egress, abuse controls, capacity, patching, and operational
  review remain necessary.
