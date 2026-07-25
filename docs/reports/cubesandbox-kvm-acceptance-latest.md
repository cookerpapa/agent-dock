# CubeSandbox KVM acceptance

- Recorded at: 2026-07-25 12:09:52 +08:00
- Upstream: TencentCloud/CubeSandbox v0.6.0
- Profile: single-node local KVM validation
- Tenant microVMs: 2
- First / second Tool latency: 2,036 ms / 1,767 ms
- Total gate time: 7,911 ms
- Guest kernel distinct from host: true
- Forbidden platform endpoints denied: 3
- Public Internet denied: true
- Cancellation destroyed executing microVM: true
- Remaining AgentDock microVMs: 0
- Network MTU: `agentdock0=1500`, Flannel/Pod `1450`

The gate created real Cubelet/CubeShim KVM guests for two independent tenant
assignments, wrote different canaries to the same Workspace path, verified each
tenant could read only its own value, captured a content-verified checkpoint,
denied platform and public network targets, cancelled a long-running command,
and confirmed exact zero-orphan cleanup.

This report proves the local KVM integration and isolation path. It does not
claim multi-node availability, node-loss recovery, rolling upgrades, production
storage durability or public-SaaS hardening.
