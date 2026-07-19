# AgentDock control plane

This package contains the Phase 1 NestJS/Fastify durable-intake boundary, an
explicit execution dispatcher, an independent durable cancellation dispatcher,
fenced event ingestion, and the resumable browser event surface. It is not yet
the production Pi executor.

## Implemented endpoints

- `POST /v1/projects` creates a project and its initial workspace atomically.
- `POST /v1/projects/:projectId/sessions` creates a cold session using the
  operator-configured default model profile.
- `POST /v1/sessions/:sessionId/turns` requires `Idempotency-Key` and returns
  `202 Accepted` only after the queued turn, pending command, and transactional
  outbox record commit together.
- `POST /v1/sessions/:sessionId/turns/:turnId/cancellations` requires a distinct
  `Idempotency-Key` and returns `202 Accepted` only after cancellation intent is
  durable. It does not imply that Pi has already stopped.
- `GET /v1/sessions/:sessionId/events` streams versioned AgentDock events as SSE
  and resumes strictly after a validated `Last-Event-ID` session sequence.

The turn stores the prompt and immutable model/credential-binding snapshot. The
command stores only a request fingerprint, and the outbox carries IDs rather
than copying the prompt or any credential material. Repeating the same key and
request returns the original acceptance; reusing the key for different content
returns `409`. Cancellation has the same semantic replay check, including its
grace period, and targets only an acknowledged active turn in v0.

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

`CancellationDispatcher.dispatchNext()` consumes a separate outbox topic, so it
can interrupt a model call while the execution dispatcher is awaiting that
call. The supervisor first returns a side-effect-free ACK. Its database commit
changes turn/session to `cancelling` and is the race's linearization point;
only afterward may the backend send Pi's native abort. Natural completion
committed before this point wins. After it, the execution dispatcher observes
rather than overwrites cancellation settlement. A matching durable
`turn.cancelled` event and process-tree confirmation are required before both
commands complete, the session returns to `idle`, and the exact lease is
released. Failure after cancellation ACK instead fails the turn/session and
retains the unconfirmed reservation for reconciliation.

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

## Docker workspace integration

The opt-in Phase 1 runner starts pinned Pi and its `bash`/`edit` tools inside a
networkless ephemeral Docker container rather than in NestJS. The host manager
passes a closed command over attached JSONL, forwards each public event through
the same durable ACK path, and requires the container to disappear after
completion or cancellation. The sample image initializes a Java fixture in
workspace tmpfs and attaches its bounded unified diff to `turn.completed`.

This integration is intentionally zero-token: the model simulator runs on
container loopback and no real credential enters Docker configuration. Run the
full image, sandbox, PostgreSQL, and SSE proof with:

```bash
npm run sandbox:check
```

## Local browser demo

The repository-level `npm run demo` command builds the same sandbox image and
the `@agent-dock/web-ui` production bundle, then starts `src/demo.ts` on
loopback. That entry point creates an ephemeral PGlite database, applies the real
migrations, seeds one fixed zero-token model profile and sandbox capacity row,
and runs execution and cancellation dispatch loops independently. Vite preview
serves the page and proxies only `/v1` to this API.

This is explicit demonstration wiring, not hidden production behavior. The
database and development checkpoint directory disappear on shutdown. Within
that runtime, successful turns persist Pi JSONL and a bounded workspace manifest
before `turn.completed`, so the same session can continue in a fresh container.
`src/main.ts` still requires operator-owned PostgreSQL/profile bootstrap and
does not start a local Docker supervisor or configure production object storage.

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
SSE, and `Last-Event-ID` replay. Cancellation coverage includes queued rejection,
idempotency, competing requests, natural-completion races, post-ACK failure
quarantine semantics, native Pi abort, forced POSIX descendant termination, and
SSE terminal delivery. Its default end-to-end path starts pinned Pi against the
loopback fake model without provider tokens. The opt-in Docker case additionally
persists and streams the ten-event Java repair and final patch.

`PGlite` is test-only. `src/main.ts` uses the production `pg`/Kysely client and
requires `DATABASE_URL`, `AGENT_DOCK_TENANT_ID`, and
`AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID`. Database migration and operator bootstrap
remain explicit deployment steps. A continuously running production worker,
production supervisor transport, durable runner spool, acknowledged-cancellation
crash recovery, generic repository restore, and a real model gateway are not
claimed by this slice. The React page is connected only through the explicit
ephemeral demo described above.

To run the identical HTTP suite against an empty real PostgreSQL database, set
`AGENT_DOCK_TEST_DATABASE_URL`. The value is consumed as configuration and is
never printed by the test.
