# ADR-0063: Hot proxy-mediated Cube web egress

- Status: Accepted
- Date: 2026-07-26
- Supersedes: the original direct CubeVS public-NAT design
- Extends: ADR-0030, ADR-0042, ADR-0053

## Context

The local production profile runs in WSL mirrored networking. The Windows
operator proxy is reachable from WSL, but Cube microVMs do not inherit host
`HTTP_PROXY` variables and cannot use a localhost proxy directly. Requiring WSL
NAT only to give every guest direct Internet access also weakens destination
mediation and makes platform-network denial depend on an ever-growing CIDR
list.

The product also needs an operator to rotate the Pi model credential/model and
the Cube upstream proxy without restarting the Control Plane, Pi Worker pool,
Cube control plane or active microVMs.

## Decision

### Closed Cube route

Every ordinary Cube create request has:

```json
{
  "allow_internet_access": true,
  "network": {
    "allowPublicTraffic": false,
    "allowOut": ["10.255.255.254/32"],
    "denyOut": ["0.0.0.0/0"]
  }
}
```

Cube evaluates the exact allow before the catch-all deny. The stable address is
a trusted host-network `cube-egress-gateway`; it is the guest's only outbound
IPv4 destination. The guest receives only the gateway host/port in standard
HTTP proxy environment variables. It receives no gateway service token,
upstream proxy URL, model key or platform credential.

The gateway accepts credential-free HTTP proxy traffic only from the Cube
route. It supports plain HTTP on destination port 80 and CONNECT on port 443.
It resolves every requested hostname in the trusted gateway, rejects the whole
answer set if any address is private, loopback, link-local, metadata,
multicast, reserved or otherwise non-public, and sends a selected resolved
public IP to the upstream proxy. This prevents upstream proxy DNS from turning
a public-looking hostname into an internal SSRF target.

This is public **web** egress for proxy-aware software, not arbitrary raw
TCP/UDP, inbound Preview publication, or a data-loss-prevention claim.

### Hot configuration

PostgreSQL is the authority for a singleton, monotonically versioned Cube
proxy configuration and its append-only audit digest. Only the platform
operator owner can read or replace it through the authenticated admin API.
Credentials in a proxy URL are forbidden.

The gateway authenticates to a separate internal read endpoint with a
file-mounted service token and polls once per second. A successful refresh
atomically replaces its in-memory configuration. New HTTP requests and CONNECT
tunnels use the new revision; already-open tunnels finish on their prior
revision. Control Plane or cluster restart is not required.

The existing model settings path remains versioned separately. An operator
model/key replacement encrypts a new credential version and updates managed
tenant profiles. A Run snapshots its exact provider, model, binding and
credential version at acceptance, so active Runs do not change identity
mid-flight; newly accepted Runs use the new configuration.

### Trust placement

The gateway is trusted execution-plane infrastructure. It runs non-root with a
read-only root filesystem, no ServiceAccount token, no Linux capabilities and
a bounded memory/CPU policy. It alone receives the polling service token. It
does not receive a model key, database URL, CubeAPI key or tenant credential.

The browser never receives either the polling token or a model credential after
submission. The admin API returns only safe model metadata and the
credential-free upstream proxy origin.

## Failure behavior

- A disabled or never-loaded proxy configuration returns `503`.
- Invalid targets, ports and private/special destinations fail closed.
- A failed poll retains the last successfully loaded revision; readiness
  requires at least one successful load.
- Invalid service identity cannot read the internal configuration.
- Cube creation fails if the exact gateway-only network policy cannot be
  encoded.
- Changing a setting never mutates an already accepted Run's model snapshot or
  rewrites an already-open network tunnel.

## Consequences

- WSL mirrored networking is supported without switching to NAT.
- Cube guests cannot bypass the trusted web gateway with a direct public or
  private IPv4 connection.
- `curl`, Git, npm, pip and Node's env-proxy mode work through the same route.
  Software that ignores HTTP proxy variables needs explicit proxy support; raw
  UDP and arbitrary TCP remain unavailable.
- A compromised Workspace may still exfiltrate bytes to an arbitrary public
  HTTP(S) host. Destination audit, tenant egress budgets and content DLP remain
  separate future controls.

## Acceptance

1. Unit tests prove exact `allowOut` plus catch-all `denyOut`.
2. Tool Worker tests prove only the stable gateway address crosses into the
   guest environment and no inherited host proxy/credential does.
3. Gateway tests prove private target denial, proxy-side resolved-IP forwarding
   and live revision switching without process restart.
4. Control Plane tests prove operator-only update, monotonic revision, audit
   digest and service-token-only internal reads.
5. A real Cube KVM guest reaches a public HTTPS endpoint through the gateway
   and fails against platform/private/metadata targets.
6. A real model Run after a model/key update consumes tokens without restarting
   the Pi Worker pool.
