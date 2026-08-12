# Sandbox control-plane adoption survey

Date: 2026-08-12

## Question

Can AgentDock delete its Sandbox Manager, and should every execution Cell own
one Manager/Data Mover stack?

## Primary-source findings

- [CubeSandbox architecture](https://cubesandbox.com/guide/architecture.html)
  assigns generic lifecycle, scheduling, guest execution and network access to
  CubeAPI, CubeMaster, Cubelet and CubeProxy.
- [CubeSandbox authentication](https://cubesandbox.com/guide/authentication.html)
  supports an external authorization callback, but it does not define
  AgentDock's tenant/Workspace/RunAttempt lease and fence model.
- [CubeSandbox volume plugins](https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/volume-plugin.md)
  provide the storage attachment mechanism; AgentDock still owns canonical
  Workspace revision and checkpoint commit rules.
- [E2B Infra architecture](https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md)
  separates its API/control path from per-node execution and sandbox traffic.
- [Kubernetes SIG Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
  and [OpenSandbox](https://github.com/alibaba/OpenSandbox) provide alternative
  lifecycle/execution platforms. They are replacements for Cube, not an
  additional Manager to stack in front of it.

## Adopt

Use Cube as the generic sandbox control and compute plane. Keep a thin,
provider-neutral Tool Broker only for AgentDock business invariants. Share one
Sandbox Domain across several lightweight execution Cells. Run Kopia Data
Movers as an independently scalable Domain service.

## Do not adopt

- Do not reproduce Cube scheduling in AgentDock.
- Do not expose Cube cluster credentials to Pi Workers.
- Do not add E2B, Agent Sandbox or OpenSandbox beside Cube merely to remove a
  small application authorization gateway.
- Do not claim direct data-path support until bounded grants preserve fencing,
  operation identity and UNKNOWN outcomes.
