# AgentDock control plane

This package contains the Phase 1 NestJS/Fastify durable-intake boundary, an
explicit outbox dispatcher, fenced event ingestion, and the resumable browser
event surface. It is not yet the production Pi executor.

## Implemented endpoints

- `POST /v1/projects` creates a project and its initial workspace atomically.
- `POST /v1/projects/:projectId/sessions` creates a cold session using the
  operator-configured default model profile.
- `POST /v1/sessions/:sessionId/turns` requires `Idempotency-Key` and returns
  `202 Accepted` only after the queued turn, pending command, and transactional
  outbox record commit together.
- `GET /v1/sessions/:sessionId/events` streams versioned AgentDock events as SSE
  and resumes strictly after a validated `Last-Event-ID` session sequence.

The turn stores the prompt and immutable model/credential-binding snapshot. The
command stores only a request fingerprint, and the outbox carries IDs rather
than copying the prompt or any credential material. Repeating the same key and
request returns the original acceptance; reusing the key for different content
returns `409`.

## Dispatcher boundary

`OutboxDispatcher.dispatchNext()` is an explicit worker primitive; the HTTP
handler never invokes it. A claim transaction selects one due outbox row with
`FOR UPDATE SKIP LOCKED`, locks the owning session, preserves per-session mailbox
order, and advances `pending/queued` to `dispatched/dispatching`. The injected
backend must await `lifecycle.started()` before doing execution work. That ACK
transaction advances the command to `acknowledged`, the turn to `running`, and
the session to `running`, and marks command delivery published in the outbox.
The incremented outbox attempt is also a local fencing token, so a claimant whose
pre-ACK lease expires cannot later ACK or perform backend work after a replacement
claim wins.

- A retryable failure before ACK returns the command/turn to
  `pending/queued` until the configured attempt limit.
- Completion settles the command and turn and returns the session to `idle` in
  one transaction; the outbox already records the earlier successful ACK.
- Any failure after ACK is terminal rather than blindly replaying possible tool
  side effects.

`DeterministicExecutionBackend` scripts these outcomes without calling a model
and records only command/session/turn IDs plus the selected outcome. It is a test
backend, is never wired into `src/main.ts`, and cannot make a production task
appear completed. The current dispatcher lease safely reclaims a crash before
ACK; a crash after ACK intentionally remains for the later supervisor
lease/fencing and reconciliation slice.

## Durable event boundary

`DurableEventStore` accepts only the closed `event.publish` wire message. A
transaction locks the session/cursor, validates turn/command ownership and the
current unexpired lease/fence, rejects sequence gaps, inserts the complete event
identity, and advances both cursor and `sessions.next_event_seq`. Only after
commit does it publish to the live hub and return `event.ack`. Exact redelivery
is idempotent—even just after lease release when an ACK packet was lost—while a
changed event at the same sequence is rejected.

The SSE stream subscribes before querying its durable replay window, sends
database rows first, then drops duplicates from the queued live overlap. Slow
subscribers have a bounded queue and reconnect from their last received ID.
This closes the single-process replay/live race; multi-control-plane live fan-out
still needs PostgreSQL notification or a broker. PostgreSQL replay itself is
restart-safe.

## Verification boundary

```bash
npm run test --workspace @agent-dock/control-plane
```

The test starts official PGlite behind its PostgreSQL wire-compatible socket,
runs all Kysely migrations, creates the NestJS application, and sends real
Fastify requests on an ephemeral loopback port. It covers validation,
durable acceptance, idempotent replay, conflicting reuse, model-policy
rejection, generic error redaction, rollback when the outbox step fails,
successful ACK/completion, concurrent claim exclusion, pre-ACK retry, post-ACK
terminal failure, commit-before-event-ACK, gap/fence/conflict rejection, live
SSE, and `Last-Event-ID` replay. Its end-to-end path starts pinned Pi against the
loopback fake model without provider tokens.

`PGlite` is test-only. `src/main.ts` uses the production `pg`/Kysely client and
requires `DATABASE_URL`, `AGENT_DOCK_TENANT_ID`, and
`AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID`. Database migration and operator bootstrap
remain explicit deployment steps. A continuously running production worker,
production supervisor transport, durable runner spool, cancellation, and the
React page are not claimed by this slice.

To run the identical HTTP suite against an empty real PostgreSQL database, set
`AGENT_DOCK_TEST_DATABASE_URL`. The value is consumed as configuration and is
never printed by the test.
