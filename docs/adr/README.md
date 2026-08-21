# Current architecture decisions

This directory contains only decisions that constrain the maintained Pi Cloud
product. Superseded experiments and pre-release decisions are intentionally not
kept beside current ADRs; Git history is their archive.

Read the documents in this order:

1. [ADR-0116](0116-kafka-first-agent-event-log.md) — Kafka-first hot Agent
   events, authority validation, SSE replay and PostgreSQL cold projection.
2. [ADR-0111](0111-current-production-architecture.md) — current end-to-end
   architecture, state authorities and scaling boundary.
3. [ADR-0112](0112-run-scoped-tool-capabilities.md) — Session grants, immutable
   Run Tool snapshots and Broker-side execution authorization.
4. [ADR-0113](0113-cloud-native-pi-subagents.md) — upstream-compatible Pi
   subagents on durable Child Sessions/Runs with explicit Workspace modes.
5. [ADR-0114](0114-conversation-subtree-delete-and-tail-prune.md) — recursive
   tree deletion and Pi-native conversation tail pruning.
6. [ADR-0115](0115-user-owned-development-environments.md) — tenant-aware,
   user-owned exclusive Cube development environments.
7. [ADR-0109](0109-postgres-session-reference-checkpoints.md) — PostgreSQL Pi
   SessionStorage as the sole conversation authority.
8. [ADR-0105](0105-pi-session-backend-conformance.md) — compatibility with Pi's
   public Session backend contract.
9. [ADR-0104](0104-human-session-tree-and-conversation-forks.md) — human tree
   navigation and conversation forks.
10. [ADR-0106](0106-workspace-web-terminal.md) — brokered human terminal access.
11. [ADR-0107](0107-remove-dormant-advanced-api.md) and
   [ADR-0108](0108-workspace-api-matches-the-file-browser.md) — deliberately
   removed product surface.
12. [ADR-0110](0110-pi-cloud-product-identity.md) — the clean Pi Cloud identity.

An ADR absent from this index is not part of the current design. Historical
migration source may contain retired table or component names solely so a new
database can replay the ordered migration chain.
