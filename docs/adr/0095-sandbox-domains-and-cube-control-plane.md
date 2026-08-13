# ADR-0095: Sandbox Domains and a thin Tool Broker

## Status

Accepted on 2026-08-12; amended on 2026-08-13 by ADR-0101.

## Decision

A Sandbox Domain binds one Cube control plane, one persistent Workspace
storage authority and a replicated Tool Broker. Cube owns generic microVM
scheduling and lifecycle. AgentDock's Broker owns only application-specific
tenant authorization, lease/fence validation, operation identity, ambiguous
Tool outcomes and Workspace revision coordination.

Workspaces bind directly to a Sandbox Domain. Pi Workers are one global shared
pool and resolve the Workspace's Domain for each Tool boundary. The former
execution Cell indirection is removed.

Workspace Volume gateways scale independently from Tool Brokers and Pi
Workers. Pi Workers never receive Cube management credentials. Adding Worker
capacity therefore does not multiply Cube control services.

## Consequences

- Pi Agent capacity, Cube compute and Broker control capacity scale separately.
- a Domain is a storage-locality/compliance/blast-radius boundary, not a Run
  scheduler;
- Domain migration is an explicit drained Workspace operation;
- direct Worker-to-Cube execution still requires an expiring activation- and
  Attempt-scoped grant, so it is not enabled by sharing broad credentials.
