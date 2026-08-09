# CubeSandbox KVM acceptance

- Recorded at: 2026-08-10 03:01:22 +08:00
- Upstream: TencentCloud/CubeSandbox v0.6.0
- Profile: single-node local KVM validation
- Tenant microVMs: 2
- First / second Tool latency: 1,810 ms / 1,256 ms
- Total gate time: 16,167 ms
- Guest kernel distinct from host: true
- Forbidden platform endpoints denied: 3
- Public Internet reachable through the configured policy: true
- Private and platform egress denied: true
- Background process survived idle TTL and a new Run/fence: true
- Revoked Tool authority rejected: true
- Cancellation destroyed executing microVM: true
- Remaining AgentDock microVMs: 0

The gate created real Cubelet/CubeShim KVM guests for two independent tenant
assignments, wrote different canaries to the same Workspace path, verified each
tenant could read only its own value, and captured a content-verified
checkpoint. It started an actual HTTP process in the persistent guest, crossed
the ordinary idle TTL, rotated Attempt/fence ownership, rejected the stale
capability, and required the same Cube runtime, PID and ticking service to
remain alive. It also allowed the configured public route while denying
private/platform targets, cancelled a long-running command, destroyed both
guests, and confirmed exact zero-orphan cleanup.

This report proves the local KVM integration and isolation path. It does not
claim multi-node availability, node-loss recovery, rolling upgrades, production
storage durability, process recovery after guest destruction or public-SaaS
hardening.
