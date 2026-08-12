# ADR-0095: Sandbox Domains and a thin Tool Broker

## Status

Accepted on 2026-08-12. This decision narrows the execution-Cell ownership
defined by [ADR-0089](0089-enterprise-cells-and-durable-event-log.md).

## Context

An execution Cell currently bundles a Temporal Task Queue, Pi Workers, a
replicated Sandbox Manager, a Cube target and a Workspace storage target. This
duplicates the trusted Manager and Kopia Data Mover for every Worker-capacity
shard even though Cube already owns generic sandbox placement and lifecycle.

Pi Worker memory and Cube compute grow approximately with active Agent and Tool
work. The trusted routing layer instead performs short control operations:
tenant and Workspace authorization, RunAttempt lease/fence validation,
operation identity, UNKNOWN settlement and Workspace commit coordination. Its
capacity and failure domain need not equal a Pi Worker Task Queue.

Cube's infrastructure API cannot replace those AgentDock-specific invariants.
Giving Pi Workers a Cube management credential would also collapse the trusted
boundary. A small application gateway therefore remains necessary, but a
second generic sandbox scheduler does not.

## Decision

1. Introduce a **Sandbox Domain** as the stable binding of one Cube control
   plane, one Workspace storage authority and one replicated Tool Broker.
2. An execution Cell contains only a versioned Temporal Task Queue, a Pi Worker
   capacity pool and its Supervisor management route. Multiple Cells may map to
   the same Sandbox Domain.
3. Rename the former Sandbox Manager authority to **Tool Broker**. Cube remains
   authoritative for sandbox scheduling and lifecycle. The Broker keeps only
   AgentDock-specific authorization, lease/fence, operation ledger, UNKNOWN
   and Workspace commit semantics.
4. Tool Broker ownership and activation records are partitioned by
   `sandbox_domain_id`, not `cell_id`. Workspace placement is still immutable
   at the Cell level; the Cell resolves its Sandbox Domain at execution time.
5. Workspace Data Movers are independent Sandbox-Domain services, not Tool
   Broker sidecars. Their CPU, memory and replica count can be scaled without
   multiplying Broker ownership processes.
6. Pi Workers receive no Cube management key. Tool execution continues through
   the Broker until an activation-scoped, attempt-scoped, expiring data-plane
   grant can preserve operation UNKNOWN and fencing semantics end to end.
7. A Sandbox Domain is a capacity and blast-radius boundary. Deployments may
   start with one Domain shared by many Cells, then add Domains only for storage
   locality, independent Cube clusters, compliance or failure isolation.

## Consequences

- Adding a Pi Worker Cell no longer creates another Manager/Data Mover stack.
- Cube compute can scale independently from Pi Worker and Broker replicas.
- Tool Broker HA remains required, but its replica count follows control-plane
  request rate and availability rather than active Agent count.
- A Domain outage can affect several Cells, so operators choose the Cell to
  Domain ratio explicitly instead of inheriting a one-to-one relationship.
- Cross-Domain Workspace migration remains an explicit drained operation.
- The direct Worker-to-CubeProxy data path is deliberately not enabled by
  passing broad Cube credentials; it requires a separate bounded-grant design.

## Adopt-before-build evidence

CubeSandbox already provides CubeAPI, CubeMaster scheduling, Cubelet lifecycle,
CubeProxy/envd execution, volumes, snapshots and network controls. E2B Infra
uses the same separation pattern: a shared API/control layer manages lifecycle
while sandbox traffic can take a dedicated data path. Kubernetes SIG Agent
Sandbox and OpenSandbox are viable alternative sandbox platforms, but adopting
either would replace Cube rather than remove AgentDock's application-specific
lease/fence boundary.

See [Sandbox control-plane adoption survey](../research/sandbox-control-plane-adoption.md).
