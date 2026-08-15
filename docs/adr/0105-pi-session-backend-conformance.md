# ADR-0105: Pi-conformant PostgreSQL Session repository

## Status

Accepted on 2026-08-15.

## Context

AgentDock already implements Pi 0.84.1's public `SessionStorage` interface in
PostgreSQL and uses it as the production conversation authority. The adapter
was initially verified through AgentDock's runtime and recovery tests, but it
did not expose Pi's complete `SessionRepo` port or run Pi's published backend
conformance suite.

That left avoidable semantic drift. In particular, Pi treats Session, Entry
and Record identifiers as opaque strings, requires one identifier namespace
across Entries and Records, defines exact fork/log/statistics behavior, and
publishes edge cases for lanes, queries, open operations and immutable reads.
The original PostgreSQL schema used UUID columns because AgentDock's product
identifiers happen to be UUIDs; that was narrower than Pi's public contract.

## Decision

1. Keep PostgreSQL as AgentDock's production Pi conversation backend.
2. Add a tenant-scoped `PostgresPiSessionRepository` implementing Pi 0.84.1's
   public `SessionRepo` interface. `SessionStorage` remains the per-Session
   implementation returned by the repository.
3. Run Pi's unmodified published `createSessionBackendConformance` cases in CI
   against the PostgreSQL repository pinned to Pi 0.84.1.
4. Store Pi Session, Entry, parent, Record and run identifiers as PostgreSQL
   `text`. Product UUIDs remain valid values, while the backend preserves Pi's
   opaque-string contract.
5. Preserve AgentDock's stronger cloud invariant separately: every mutable
   repository/storage operation may be bound to an `ExecutionAuthority`, and
   the authority check occurs in the same PostgreSQL transaction as the
   mutation.
6. Treat Pi conformance as the compatibility baseline, not as the full cloud
   safety suite. Tenant isolation, stale-fence rejection, bounded compaction
   reads and remote Tool effect tests remain AgentDock-owned contracts.

## Consequences

- Pi upgrades now have an executable backend compatibility gate instead of
  relying only on AgentDock's current call path;
- backend behavior for forks, facts, usage, queries and mutation ordering is
  aligned with Pi's reference implementations;
- the database accepts all identifiers allowed by Pi rather than accidentally
  depending on UUID syntax;
- PostgreSQL-specific multi-tenant and fencing behavior remains explicit and
  is not pushed into model-visible messages or Pi's generic interfaces.

## Rejected alternatives

- using JSONL as production storage would restore whole-file I/O and remove
  transactional tenant/fence checks;
- adopting the official SQLite backend would not provide a shared backend for
  horizontally replaceable Workers;
- maintaining only hand-written AgentDock tests would miss upstream contract
  changes and backend semantics that the product UI does not currently call.
