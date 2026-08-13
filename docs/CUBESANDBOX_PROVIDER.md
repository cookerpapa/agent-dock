# CubeSandbox Provider

## Role

CubeSandbox is AgentDock's sole untrusted execution plane. Pi and provider
authentication stay in the trusted Worker. User commands and repository code
run inside one KVM microVM bound to a tenant/Workspace/Session.

```text
Pi SDK Tool call
  → Tool adapter
  → Tool Broker (Step digest + operation ledger)
  → Cube API
  → Cube microVM Tool service
  → bounded result
  → Pi Agent Loop
```

## Why Cube

Cube supplies the capabilities needed by an interactive coding Agent:

- hardware-backed guest kernel boundary;
- reusable Linux templates;
- scheduling and lifecycle APIs;
- volume integration;
- traffic proxy integration;
- pause/resume primitives;
- independent process and filesystem environment.

AgentDock does not treat Cube lifecycle state as durable conversation state.
Pi Session checkpoints and Workspace checkpoints remain external and fenced.

## Template

The deployment-owned template contains:

- Debian userland;
- Node.js 24, Java 17, Python 3 and Git;
- the AgentDock Tool service;
- a fixed unprivileged user;
- `/workspace` volume mount;
- no deployment secrets.

Users cannot submit a template, image, kernel, device, mount, privileged flag
or network policy.

## Authority handoff

An activation starts with a binding hash and random handoff secret known only
to the trusted Manager and guest Tool service. Every request carries:

- current handoff secret;
- current fencing token;
- physical binding hash;
- frozen logical Turn digest, current Attempt digest, current per-sampling Step
  digest and one immutable operation ID.

Warm reuse rotates authority before another Run can execute. A stale Worker may
still exist, but its old capability and fence are rejected.

The Manager and guest Tool service retain bounded process-local operation
ledgers. A short transport disconnect can reattach to the same exact request;
it cannot create a second command. If either ledger or the VM disappears, the
result is `UNKNOWN` and the activation is destroyed rather than replayed.

## Workspace

The Workspace is a Workspace-bound Cube Volume/POSIX directory. It remains
mounted while the activation is warm. At a commit boundary:

1. stop accepting old-fence Tool operations;
2. quiesce the Tool mutation boundary;
3. flush the Workspace;
4. capture a bounded persistent-Volume revision through the trusted gateway;
5. CAS the PostgreSQL Workspace head;
6. return the activation to `IDLE_WARM` or destroy it while retaining the Volume.

Background processes can remain alive during a warm idle window. They are not
promised across activation destruction or failure.

## Network

Cube is created with Internet support, while Web traffic is explicitly routed
through the trusted Cube egress gateway. The gateway:

- accepts only HTTP proxy and HTTPS CONNECT;
- resolves targets itself;
- rejects private/link-local/metadata/platform addresses;
- supports a hot-configured upstream proxy;
- has no tenant/model/database credential.

Tools that ignore `HTTP_PROXY`/`HTTPS_PROXY` do not gain a secret direct route
through AgentDock's gateway.

## Runtime evidence

The Provider validates:

- exact template/image revision;
- guest kernel and hypervisor evidence;
- UID/GID and `no_new_privs`;
- effective capabilities;
- CPU and memory shape;
- expected Tool service identity;
- public-proxy/private-denied network mode.

Invalid evidence prevents the activation from serving Tools.

## Reconciliation

Cube inventory metadata records immutable creation identity and every
fence-qualified assignment. The Manager periodically compares desired
PostgreSQL state with live inventory.

Cleanup requires both logical identity and physical runtime identity. An old
cleanup request cannot delete a newer activation with a reused logical name.

## Known limits

- Warm processes survive only while the exact activation remains valid.
- A cold restore recovers files and Git state, not RAM, sockets or PTYs.
- Public egress is proxy-aware and policy constrained.
- The single-node deployment shares one physical host; host/KVM/Cube
  administrative compromise remains in the trusted computing base.

## Verification

```bash
npm run cubesandbox:template-check
npm run cubesandbox:live-check
npm run production:check
```

The Provider live gate starts a real background service inside Cube, releases
the Run with persistent retention, advances beyond the ordinary warm TTL and
rebinds the same physical KVM guest under a new Attempt/fence. It requires the
same PID and service endpoint to remain alive, rejects the old Tool capability,
then destroys the guest and proves zero orphaned runtimes. The production gate
also propagates the persistent policy through the public API and Worker path
and requires conversation archival to reap the retained guest. Live checks
require a running Cube cluster and explicit acknowledgement when real model
calls are enabled.
