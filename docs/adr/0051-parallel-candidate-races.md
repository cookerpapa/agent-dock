# ADR-0051: Parallel candidate races and deterministic promotion

- Status: Accepted
- Date: 2026-07-23
- Extends: ADR-0025, ADR-0031, ADR-0032, ADR-0047

## Context

Opening several coding-agent windows is not a durable multi-Agent system. A
useful parallel workflow must identify one immutable base, isolate every writer,
bound fan-out, preserve dispatch authority, evaluate the results with the same
checks, and merge one selected result without letting stale work overwrite a
newer Workspace.

AgentDock already has the required lower-level mechanisms:

- an immutable `WorkspaceVersion` and cold Session fork;
- per-Session serialization and globally fair tenant dispatch;
- independent Run, Attempt, lease and fencing identities;
- one gVisor Tool Sandbox per active candidate Session;
- immutable Review Bundles containing changes, tests, usage and artifacts.

The missing boundary is an AgentDock-owned orchestration object above ordinary
Runs. Pi must remain unaware of Kubernetes identities, sibling candidates and
winner-promotion authority.

## Decision

The first parallel workflow is a bounded **candidate race**. One idempotent
request fixes:

```text
parent Session
base WorkspaceVersion
task prompt
2..4 labelled candidate strategies
maximum concurrent candidates
deterministic acceptance policy
```

Creation locks the parent Session and tenant policy, verifies that the parent
has no unsettled work and that the requested base is still current, reserves
all required Session and unsettled-Turn capacity, and atomically creates:

```text
OrchestrationRun
DecisionGate
N child Sessions
N fork WorkspaceVersions
N ordinary Turn / Command / Run / Outbox records
N Candidate and Dispatch records
```

Every child starts from the same Pi artifact and Workspace bytes, but owns an
independent Session event stream, Run/Attempt history and Tool Sandbox. Existing
tenant fairness remains the outer scheduling policy. An additional correlated
admission check limits active Runs from one Orchestration to its
`maximum_concurrent_candidates`.

Candidate completion is evaluated from the immutable Review Bundle. The first
closed acceptance policy supports:

- requiring a Workspace patch;
- requiring at least one effective structured test and requiring every effective
  result to pass. A conservative shell-command classifier extracts supported
  test runners/scripts from compound commands, rejects incidental filename
  mentions, and canonicalizes `/workspace` paths. For each canonical test
  invocation, the final result is authoritative, so an initial red test
  followed by the same green regression test is accepted while the complete
  red/green history remains in the immutable Review Bundle;
- a maximum changed-path count;
- protected path prefixes.

The resulting Acceptance record is immutable. Its scorecard contains only
deterministic evidence: Run state, test counts, changed paths, model requests,
tokens, cost and duration. AgentDock may recommend the best passing Candidate
by a stable tuple, but a model opinion is not a release gate.

The first Decision Gate is human-resolved. Promotion:

1. locks the Orchestration, gate, parent Session and selected Candidate;
2. requires a passing immutable Acceptance result;
3. requires the parent's current version to equal the Orchestration base;
4. requires no unsettled parent work;
5. creates a new parent `WorkspaceVersion` by referencing the winning
   Candidate's Workspace/patch artifacts and the parent's existing Pi artifact;
6. advances the parent pointer with compare-and-swap;
7. records one immutable promotion and resolves the gate.

Promotion is intentionally Workspace-only. Candidate conversations remain
auditable child Sessions; the parent conversation does not silently acquire
messages that never appeared in its event stream.

## Invariants

- Candidate writers never share one live Session or Tool Sandbox.
- All Candidates in a race start from the exact same settled base version.
- Candidate fan-out is bounded by tenant capacity and Orchestration capacity.
- The model cannot choose candidate count, runtime, PodSpec, provider or winner.
- A stale Dispatch or RunAttempt cannot bypass existing lease/fence checks.
- Acceptance is derived from one content-verified Review Bundle and cannot be
  updated after insertion.
- Promotion requires a passing candidate and expected-parent-version CAS.
- A Candidate Workspace is never reassigned to another tenant or Session.
- Arbitrary shell execution is not described as exactly once.

## Cancellation

Cancellation first changes the Orchestration to `cancel_requested`, which makes
its not-yet-claimed candidates ineligible for normal dispatch. Queued candidates
are withdrawn transactionally. Active acknowledged Runs receive the existing
durable Turn cancellation command. The Orchestration becomes `cancelled` only
after every child Run is terminal; cancellation does not infer process absence
from an HTTP response.

## Consequences

This slice adds durable fan-out/fan-in, consistent candidate review and an
auditable winner boundary without changing Pi or weakening same-Session
serialization. It deliberately precedes general task-DAG decomposition: a DAG
also requires integration ordering, conflict gates and full regression tests
after every merge.

The current Kubernetes/gVisor provider remains sufficient. A future
CubeSandbox provider may optimize clean-base cloning, but its microVM snapshots
are not the durable Workspace authority and cannot be a prerequisite for the
orchestration protocol.
