# ADR-0071: Embedded Pi SDK runtime

Status: accepted

## Context

The repository once carried both an embedded Pi SDK runtime and a Pi RPC
subprocess runtime, plus several JSONL restore formats. Those branches doubled
the executable and test surface and allowed deployment configuration to select
an unmaintained path.

The production runtime now stores Pi entries and Compaction boundaries directly
through PostgreSQL SessionStorage.

## Decision

- Pi SDK execution is the only supported Agent Loop.
- Each trusted Pi Worker runs a bounded set of `PiCloudTurnRunner` slots.
- Tools are registered against the current remote Sandbox activation.
- Conversation restore opens the tenant-scoped PostgreSQL Session branch.
- No Pi subprocess, Worker-local JSONL, manifest reader or object-store
  conversation fallback remains.

## Consequences

- A missing setting cannot reactivate the retired subprocess runtime.
- A poisoned Worker can be replaced while durable Session state remains in
  PostgreSQL.
- Upgrading Pi or the SessionStorage schema requires an explicit migration and
  backend conformance test.
- Development JSONL checkpoints are discarded rather than silently imported.
