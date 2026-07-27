# Implementation roadmap

This file describes the current dependency order. Completed historical work is
preserved in [BACKLOG.md](BACKLOG.md), ADRs and the implementation log.

## Completed foundation

- Pi SDK Agent Loop with native Session/compaction restore;
- PostgreSQL durable Run/Attempt/event state;
- resumable SSE;
- multi-tenant authentication and quotas;
- Temporal as the sole Run scheduler;
- horizontally scalable, capacity-aware Pi Worker pool;
- CubeSandbox KVM as the sole Tool runtime;
- leased/fenced Tool RPC;
- public-only proxy egress with hot administrator configuration;
- Cube Volume/POSIX/Kopia Workspace persistence;
- immutable Pi and Workspace checkpoints;
- live fault, load and token-consuming acceptance;
- conversation/product UI and dedicated administrator settings.

## Current product milestone

- [x] Remove executable alternate Sandbox runtimes and deployment compatibility.
- [x] Make Workspace a named, first-class user directory.
- [x] Select or create a Workspace when starting a conversation.
- [x] Store conversation titles independently from Workspace names.
- [x] Add conversation deletion without deleting the shared Workspace.
- [x] Replace the operational inspector with a committed directory/file view.
- [x] Separate platform administrator identity from tenant ownership.
- [x] Remove the browser repository-import workflow.
- [ ] Complete full CI, production migration and live browser/API acceptance.

## Next reliability milestone

- retained-data policy and hard deletion worker;
- explicit Tool `UNKNOWN` UX for ambiguous side effects;
- multi-node failure injection for Worker/node loss;
- object/checkpoint orphan garbage collection dashboards;
- measured Session-affinity hit rate and queue-delay tuning;
- sustained load evidence at the target Worker/Cube capacity.

## Next product milestone

- structured Git diff/file edit view;
- artifact downloads and test-result navigation;
- explicit Workspace fork/rollback UX;
- Preview lifecycle for Web applications;
- GitHub App delivery through a trusted adapter;
- organization/RBAC administration and audit search.

## Release quality

Every new claim requires:

1. source-level tests;
2. a deterministic failure test;
3. real deployment evidence where the boundary is infrastructural;
4. documentation and threat-model update;
5. measured values rather than guessed performance numbers.

Features are not added by retaining a dormant implementation. A new execution
backend must re-enter through an ADR, the Provider contract and the complete
shared acceptance suite.
