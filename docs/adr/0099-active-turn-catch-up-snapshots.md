# ADR-0099: Active-Turn catch-up snapshots

## Status

Accepted on 2026-08-12.

## Context

Completed Turns load from PostgreSQL's semantic conversation projection, but
an active Turn still exists as a retained Valkey event suffix. Reopening a
conversation previously started SSE at the last completed terminal sequence.
That was correct, but a long active Turn had to replay every text and Tool
delta before its current transcript reappeared, producing avoidable latency
and UI churn.

The optimization must preserve the stronger visibility invariant: the browser
may only observe events already covered by PostgreSQL's projected cursor. It
must also handle a Run settling while the conversation and snapshot requests
are in flight.

## Decision

1. Event Gateway exposes an authenticated active-Turn snapshot endpoint. The
   snapshot is materialized from the exact contiguous Valkey suffix ending at
   PostgreSQL's projected watermark.
2. The response contains a replay watermark. The browser hydrates the active
   transcript once and opens SSE strictly after that sequence, so subsequent
   events remain contiguous and resumable.
3. If the projected watermark is a PostgreSQL-owned terminal event, the
   snapshot stops one sequence earlier. SSE must deliver that terminal event;
   the snapshot never pretends that Valkey owns it.
4. PostgreSQL remains the sequence and ownership authority, Valkey remains a
   rebuildable payload read model and Pi Session JSONL remains the model-context
   authority. The snapshot cannot advance any durable state.
5. Snapshot failure falls back to ordinary SSE replay from the canonical
   conversation boundary. A missing or non-contiguous Valkey range fails the
   endpoint closed rather than returning a partial transcript.

## Consequences

- Reloading a long active Turn requires one bounded snapshot response instead
  of rendering its full delta history through SSE.
- A completed-Turn/active-snapshot race remains lossless because the browser
  resumes before the terminal event.
- This is a read-path optimization, not a new conversation store. Recovery and
  future model input continue to use Pi's native checkpoint.
