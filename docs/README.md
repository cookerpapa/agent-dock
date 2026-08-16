# Documentation map

Use documentation in this order:

1. [`README.md`](../README.md) — product, one-message path and deployment entry.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — maintained component and authority
   model.
3. [`RUN_LIFECYCLE.md`](RUN_LIFECYCLE.md) and
   [`THREAT_MODEL.md`](THREAT_MODEL.md) — correctness and security invariants.
   [`CUBESANDBOX_PROVIDER.md`](CUBESANDBOX_PROVIDER.md) defines the current Tool
   execution boundary.
4. [`CONFIGURATION.md`](CONFIGURATION.md),
   [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) and
   [`DISTRIBUTED_DEPLOYMENT.md`](DISTRIBUTED_DEPLOYMENT.md) — operations.
5. [`adr/README.md`](adr/README.md) — current decisions only.

`reports/` contains evidence tied to a named revision and topology. `research/`
contains background analysis, not product truth. The implementation-log stub
and chat transcripts only point to historical context and must never override
the sources above.

Superseded ADRs and retired architecture documents are kept in Git history
instead of the current tree. This is intentional: repository-reading agents
should not have to infer which of several mutually exclusive production paths
is real.
