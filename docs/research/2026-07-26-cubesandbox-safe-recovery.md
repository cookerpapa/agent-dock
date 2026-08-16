# CubeSandbox v0.6.0 recovery research

## Scope

This note records the upstream behavior that PiCloud relies on before using
Cube pause/resume across Runs. The evaluated source is the immutable
`TencentCloud/CubeSandbox` tag `v0.6.0`, commit
`8721dd151971ce3c2966482bbd32904ad98f378e`.

## Upstream standard lifecycle

Cube exposes two supported recovery paths:

1. explicit `POST /sandboxes/{id}/pause`, followed by
   `POST /sandboxes/{id}/connect`; and
2. `lifecycle.on_timeout = "pause"` plus `auto_resume = true`, where the
   lifecycle manager parks an idle VM and CubeProxy resumes it on the next data
   request.

Both paths preserve the guest filesystem, process memory and CPU state. An
outbound socket is not guaranteed to remain usable and must be reopened after
resume. The private-ingress traffic token is returned by create and must remain
in the trusted caller; reconnect is not a credential recovery mechanism.

The platform-managed path is coordinated as follows:

- CubeMaster publishes lifecycle metadata and state events through Redis;
- Cube Lifecycle Manager (CLM) owns idle sweeping and request-triggered resume;
- CubeProxy publishes last-active observations and blocks data requests while
  a sandbox is `pausing` or `resuming`;
- the CLM resumer coalesces concurrent requests in-process;
- a Redis `SETNX` state key serializes `pausing` / `paused` / `resuming` /
  `running` transitions across replicas; and
- state-sync consumers reconcile transitions initiated outside CLM.

Cube treats "already paused/running" as reconciliation success, evicts a
not-found sandbox, and clears the transition state after a genuine RPC error so
a later attempt can retry. Explicit pause polls the detail endpoint until
`paused`. Connect returns a fresh runtime view after resuming.

## Boundary that Cube does not provide

Cube lifecycle coordination answers:

> Is this physical microVM paused, resuming or running?

It does not answer:

> Which PiCloud RunAttempt and fencing token is currently allowed to mutate
> this Workspace?

Redis lifecycle state, Cube metadata and a Cube traffic token are therefore not
business fencing tokens. PiCloud must seal the guest before pause, revoke the
old Tool capability, and require a strictly higher writer fence before the
resumed guest accepts another Tool operation.

## Selected PiCloud recovery profile

PiCloud uses the explicit upstream pause/connect API, not transparent
request-triggered auto-resume:

```text
capture committed Workspace
  -> seal guest Tool service
  -> prove no uid-1000 process remains
  -> pause and observe paused
  -> retain exact-Session warm handle
  -> receive a later, higher-fence RunAttempt
  -> connect and observe running
  -> authenticated rebind with a rotated handoff secret
  -> start a fresh uid-1000 Tool Worker
  -> accept Tool operations
```

Transparent auto-resume is deliberately disabled because a data request must
not wake a VM before PiCloud has validated the new lease and fencing token.
Cube remains the physical lifecycle authority; PostgreSQL remains the business
state authority.

If pause, connect, identity verification or rebind has an ambiguous result,
PiCloud destroys the microVM and recreates it from the latest committed
content checkpoint. Warm recovery is an optimization, never the only durable
copy.

The warm handle is process-local to the singleton Sandbox Manager. A graceful
Manager shutdown destroys it. After an ungraceful Manager loss, startup
reconciliation destroys the orphan because the private handoff authority was
intentionally not persisted. This avoids creating a second durable ownership
database for an optimization.

## Network conclusion

Cube supports deny-all Internet, CIDR/domain allow lists and CubeEgress L7
rules. In v0.6.0, DNS-learned addresses enter the same allow map as static
addresses and are checked before deny rules. PiCloud therefore does not use
native domain learning as the hostile-tenant dependency boundary.

Dependency setup continues through PiCloud's existing Ed25519 capability
proxy:

```text
disposable gVisor dependency-bootstrap Pod
  -> exact HTTPS hosts through capability proxy
  -> content capture
  -> destroy bootstrap Pod
  -> restore into a fresh deny-all Cube microVM
  -> run offline verification
```

The ordinary Cube Tool VM never receives the proxy capability and never has
Internet access. General interactive Bash networking remains unsupported.

## Known upstream failure considerations

- Paused-resource release can make resume fail admission on a full node.
- A pause/resume timeout is not proof that the operation did not apply; state
  must be re-read before deciding.
- Native Cube snapshots are useful for execution optimization, but PiCloud's
  object-store content checkpoint remains the portable commit.
- A networked guest snapshot must never be repurposed as an offline guest
  identity.

## Primary sources

- `docs/guide/lifecycle.md`
- `sdk/node/src/sandbox.ts`
- `examples/code-sandbox-quickstart/auto-resume.py`
- `cube-lifecycle-manager/internal/resumer/resumer.go`
- `cube-lifecycle-manager/internal/sweeper/sweeper.go`
- `docs/architecture/network.md`
- CubeSandbox pull requests `#404`, `#553`, `#613` and `#956`

