# ADR-0043: Optional Cloud Agent product modules

- Status: accepted as optional modules
- Date: 2026-07-22
- Extends: ADR-0031, ADR-0032, ADR-0040, ADR-0042

## Context

Research into production Cloud Coding Agents showed value in environment
governance, exact source identity, attempt supersession and immutable review
evidence. Those capabilities are useful for experiments and future product
work, but they do not belong on the default chat-to-code critical path.

The source analysis remains in
[`../research/2026-07-22-cursor-cloud-agent-lessons.md`](../research/2026-07-22-cursor-cloud-agent-lessons.md).

## Decision

1. Environment configuration/validation, model and usage governance, Candidate
   Race, rewind and Review Bundle services remain maintained optional backend
   modules.
2. They are disabled by default behind
   `AGENT_DOCK_ADVANCED_MODULES_ENABLED=true` and do not add routes or workers to
   the core deployment when disabled.
3. The separate GitHub Gateway remains an explicit `github` Compose profile for
   repository-import experiments. It is not part of the default product flow.
4. Removed browser product surfaces—Preview, structured Diff, Artifact/test
   navigation, Fork/Rollback, GitHub App/PR delivery, organization/RBAC and
   audit-search pages—are not implied by retaining backend experiments.
5. Optional modules still obey tenant authorization, immutable RunAttempt
   history, fencing, bounded artifacts and credential isolation.
6. A module may return to the default path only with a current product contract,
   UI/API closure, measured benefit and a new or amended ADR.

## Consequences

- Advanced experiments remain available without making the default system look
  like several products combined.
- Core deployment and review can focus on Pi, Temporal, durable events, Cube and
  Workspace recovery.
- Historical gVisor/Helm/prewarm implementation details are retained only in Git
  history and acceptance reports; they are not supported runtime choices.
