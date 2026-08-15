# ADR-0050: Capability-free trusted provider egress relay

- Status: Accepted
- Date: 2026-07-23
- Extends: ADR-0027, ADR-0029

## Context

The trusted Supervisor owns Pi, the loopback Model Gateway and the encrypted
model-credential resolver. It must reach the fixed model provider, while Tool
Pods must not receive that network path or any provider credential.

The production host can also be deployed behind an operator HTTP proxy. On the
validated WSL2 host, a reboot left the Linux network namespace without a
default public route while the operator proxy remained available only on host
loopback. Giving the Supervisor host networking would restore connectivity but
would also collapse its network boundary. Passing the operator proxy address
directly into every trusted application would couple runtime code to host
topology and preserve a direct-egress network alongside the proxy.

The reviewed `maidangzhu/cloud-agent-platform` design reinforces a useful
separation: Agent code should receive short-lived access to trusted proxy
services, while outbound provider authority remains in a narrow trusted
boundary. AgentDock already has a request-scoped Model Gateway capability. It
also needs a transport-only path that does not expose host networking to the
Runner.

## Decision

Production adds a two-stage provider egress relay:

```text
Trusted Supervisor / loopback Model Gateway
        |
        | HTTP CONNECT through internal model-egress
        v
provider-egress-relay (TCP 3129, no host network)
        |
        | private Unix-domain socket in a 0700 named volume
        v
provider-host-egress-relay (host network, no TCP listener)
        |
        +-> operator HTTP(S) proxy, when configured
        `-> public IPv4 for the exact provider host otherwise
```

The bridge relay only forwards opaque bytes between its private TCP listener
and the Unix socket. The host relay accepts only syntactically valid
`CONNECT api.deepseek.com:443`, resolves and rejects non-public IPv4 answers
when connecting directly, bounds connect and tunnel duration, and emits
content-free audit records. TLS remains end-to-end between the Model Gateway's
provider client and DeepSeek; neither relay receives the model API key or
decrypts provider traffic.

The Supervisor joins the internal `model-egress` network and does not join the
externally routed `provider-egress` network. Node's environment-aware proxy
dispatcher sends public provider requests through the relay, while an explicit
`NO_PROXY` set keeps fixed internal services on their isolated Compose
networks. The host relay is the only host-network service. It listens only on a
Unix socket, runs non-root with a read-only root filesystem, dropped
capabilities, bounded CPU/memory/PIDs and no Docker/containerd socket or
platform credential.

This relay is not a Tool capability and is never described to Pi. Tool and
Cube Tool guests cannot join Compose networks and remain governed by their
separate deny-all or Ed25519 capability-scoped Kubernetes egress policies.

## Correctness and security

- Browser or model input cannot select a destination, proxy, port or relay.
- The provider allowlist is operator-owned and closed at startup.
- The bridge has no host network, provider key, database/object-store
  credential or application service credential.
- The host relay has no model key or platform credential. An operator upstream
  proxy is transport configuration, not Agent-visible state.
- Direct DNS answers are capped and every answer must be public IPv4; mixed
  public/private answers fail closed.
- Ordinary HTTP requests and CONNECT targets other than the exact allowlist
  fail closed.
- The production gate inspects network membership, host-network exclusivity,
  mounts, capabilities, proxy environment, allowlist and secret absence.
- A real-model acceptance check must observe completed provider usage after
  deployment; configuration-only success is insufficient.

## Consequences

The trusted Runner can use a host-loopback operator proxy without receiving
host networking or a direct public route. The additional two small processes
and one private socket volume become trusted transport infrastructure and must
be health-checked and patched.

Compromise of the host relay could use the host network under the privileges of
its non-root process. The fixed image, no secrets, no TCP listener, narrow
destination policy and resource limits reduce that blast radius but do not
replace host hardening. The current relay is intentionally provider-specific;
adding another provider requires an explicit operator allowlist and acceptance
evidence rather than a client-provided URL.
