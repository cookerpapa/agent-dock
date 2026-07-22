# ADR-0047: Attempt rewind and immutable Review Bundles

- Status: Accepted
- Date: 2026-07-22
- Extends: ADR-0031, ADR-0032, ADR-0043

## Context

A durable Run may fail after model or Tool work has started. Reposting its text
as an unrelated prompt hides the execution boundary, can continue from a newer
Workspace than the failed Run saw, and makes the browser disagree with the
append-only audit history. A reviewer also needs one bounded description of the
result instead of reconstructing it from messages, events, artifacts, tests,
usage and environment evidence.

AgentDock cannot make arbitrary shell side effects exactly once. Rewind must
therefore create new work from a committed boundary; it must never replay an
ambiguous ToolExecution inside an old Attempt.

## Decision

Every accepted Run persists three explicit bases:

```text
conversation_base_seq
workspace_base_version_id
pi_session_base_artifact_id
```

`POST /v1/runs/:runId/rewinds` is an actor-bound, idempotent mutation. It accepts
only the exact current Attempt of the latest terminal Run in an idle/cold/failed
Session. In one PostgreSQL transaction it:

1. locks the source Run, Turn, Command and Session;
2. verifies that no earlier rewind superseded the source;
3. restores the Session's Workspace and Pi pointers to the source bases;
4. appends a replacement Turn, Command, Run and outbox record using the source
   prompt, model binding, environment snapshot and repository-set snapshot;
5. appends a `run_rewinds` audit row with actor and idempotency key.

No Attempt, event, artifact or message is deleted. The source Run and its
Attempts project as `superseded`; the replacement projects as `canonical` and
links to the source boundary. Browser reconnect derives the same projection
from durable rows. A warm Sandbox whose committed revision no longer matches
the restored base is destroyed rather than adopted.

Successful Run settlement also creates one Review Bundle in the same database
transaction. The closed manifest contains bounded plain data and opaque IDs:

```text
final assistant text + complete-text hash
changed paths + patch/workspace artifact identities and hashes
test results
artifact metadata (never object-store keys)
environment and exact source-set snapshots
RunAttempt history and projection
token/cost usage
environment validation evidence
```

The manifest is serialized with stable recursive key ordering, SHA-256 hashed,
and stored in `review_bundles`. A database trigger rejects updates and deletes.
Reads recompute and verify the hash before returning tenant-scoped data. The Web
UI renders ordinary React text and authenticated artifact links; it does not
inject manifest HTML.

## Invariants

- One source Run can have at most one replacement Run.
- One idempotency key in a Session describes one exact rewind request.
- Only the current source Attempt and latest Session Run can be rewound.
- Rewind restores committed bases; it does not replay a ToolExecution.
- Event and Attempt history remains append-only.
- A Review Bundle is created only for the current settled Attempt and is
  immutable after insertion.
- Foreign tenant UUIDs are indistinguishable from absent resources.

## Exclusions

- Arbitrary branching from an old non-latest Run is not a rewind. Workspace
  fork already provides an explicit branch operation.
- AgentDock does not claim exactly-once shell execution.
- Review Bundles do not embed raw active HTML, object-store keys, secrets or
  unbounded command output.
- Rewind does not alter the source environment, repository set, model or
  provider credential binding.

## Consequences

The user can retry failed work without losing audit evidence or accidentally
continuing from the wrong Workspace. Reviewers receive one content-verified
handoff surface. The cost is additional base pointers, projection queries and a
strict latest-Run limitation; that limitation is preferable to pretending an
arbitrary historical process state can be restored safely.
