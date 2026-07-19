# AgentDock control plane

This package contains AgentDock's NestJS/Fastify durable-intake boundary, an
explicit execution dispatcher, an independent durable cancellation dispatcher,
fenced event ingestion, the resumable browser event surface, and an explicit
remote Supervisor worker composition. It is not yet a complete production Pi
deployment for arbitrary repositories/providers, but the deterministic private
multi-tenant slice is composed in the supported single-host topology.

## Implemented endpoints

- `POST /v1/registrations` is the only optionally anonymous route. When the
  operator explicitly enables it, one transaction creates a bounded tenant,
  owner, deterministic model profile/policy, and indexed owner credential. The
  plaintext token is returned once; disabled deployments return `404`.
- `GET /v1/identity` returns the verified tenant slug, tenant-local user, and
  `owner`/`member`/`viewer` role without credential metadata.
- `GET /v1/conversations` returns only the authenticated tenant's newest 100
  sessions and an explicit truncation flag.
- `GET /v1/conversations/:sessionId` returns project/session metadata and the
  newest 200 durable prompt turns. A known foreign session is indistinguishable
  from a nonexistent session, and truncated history includes a safe SSE replay
  boundary.
- `POST /v1/projects` creates a project and its initial workspace atomically.
- `POST /v1/projects/:projectId/sessions` creates a cold session using the
  operator-configured default model profile.
- `POST /v1/sessions/:sessionId/turns` requires `Idempotency-Key` and returns
  `202 Accepted` only after the queued turn, pending command, and transactional
  outbox record commit together. It also returns the immutable per-session
  mailbox position allocated in that transaction.
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
grace period, and targets only an acknowledged active turn in v0. A normal
prompt submitted while a turn is active is another queued follow-up, not steer;
it consumes no process, container, or lease until it reaches the head.

## Dispatcher boundary

`OutboxDispatcher.dispatchNext()` is an explicit worker primitive; the HTTP
handler never invokes it. A claim transaction selects one due outbox row with
`FOR UPDATE SKIP LOCKED`, locks the owning session, preserves per-session mailbox
order by the lowest nonterminal execute-command `mailbox_position`, applies the
tenant concurrent-turn limit, orders eligible tenants by a durable
least-recently-served cursor, and advances
`pending/queued` to `dispatched/dispatching`. Timestamp and UUID order are not
correctness inputs. The injected
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

## Remote control-plane composition

`createRemoteControlPlaneRuntime()` wires one shared `DurableEventStore` and
`SessionEventHub` into Nest/SSE and the WebSocket command router, then constructs
the authenticated Supervisor gateway, durable connection manager, bounded
worker runtime, and assignment reconciler factory. It requires the caller to
provide a real `SupervisorUpgradeAuthorizer`, `SupervisorOwnerBoundary`, and
assignment-inventory factory; it does not invent a no-op process owner.

The worker has one sequential discovery loop and one independent maintenance
loop per control-plane process. Each current local Supervisor connection gets
at most `min(maxConcurrentSessions, maxLanesPerConnection)` promise-based
execute lanes and the same number of independent cancellation lanes. A lane
awaits one dispatcher call at a time, so concurrency is explicit and bounded by
live capacity rather than session count. A cold session owns no process, OS
thread, socket, polling loop, or Pi runtime.

`RemoteControlPlaneRuntime.close()` is idempotent. It stops discovery from
starting new claims, rejects new Supervisor upgrades, closes and detaches active
command transports, waits for dispatchers to apply their existing pre-ACK retry
or post-ACK ambiguous-failure policy, then closes Nest and notification
listeners. This composition never executes Pi or untrusted extensions inside
the control-plane process; those remain behind the outbound Supervisor socket.

## Durable event boundary

`DurableEventStore` accepts only the closed `event.publish` wire message. A
transaction locks the session/cursor, validates turn/command ownership and the
current unexpired lease/fence, rejects sequence gaps, inserts the complete event
identity, and advances both cursor and `sessions.next_event_seq`. Only after
commit does it wake the local hub and return `event.ack`. When the PostgreSQL
notification transport is configured, the same transaction emits a versioned
tenant/session/sequence high-water hint. Exact redelivery is idempotent—even
just after lease release when an ACK packet was lost—while a changed event at
the same sequence is rejected.

The SSE stream subscribes before querying its durable replay window, sends
database rows first, then reacts to coalesced high-water wakes. The hub retains
at most one wake per subscriber and never queues event bodies; slow subscribers
read their missing contiguous suffix from PostgreSQL. Every production replica
uses one reconnecting dedicated `LISTEN` connection. Duplicate hints collapse,
listener reconnect wakes all local streams, and an idle SSE heartbeat polls the
durable cursor to recover a missed hint. PostgreSQL replay remains the authority
and browser reconnect still resumes from `Last-Event-ID`.

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

## Settled checkpoint object storage

`PostgresSandboxCheckpointStore` keeps lease/fence validation, revision CAS,
artifact metadata, independent SHA-256 hashes, and the authoritative settled
pointer pair in PostgreSQL. Its byte-store interface has two implementations:

- `FileCheckpointObjectStore` is the private-directory adapter used by the
  ephemeral local demo.
- `S3CheckpointObjectStore` stores the same bounded logical keys in one
  configured S3-compatible bucket/prefix. It uses conditional single-part
  writes, precomputed SHA-256 checksums, bounded downloads, and safe error
  translation. It never receives a database connection or sandbox identity.

The production worker can call
`createS3CheckpointObjectStoreFromEnvironment()`. It recognizes:

- `AGENT_DOCK_CHECKPOINT_S3_BUCKET` (required);
- `AGENT_DOCK_CHECKPOINT_S3_REGION`, falling back to `AWS_REGION` or
  `AWS_DEFAULT_REGION`;
- optional `AGENT_DOCK_CHECKPOINT_S3_ENDPOINT` and
  `AGENT_DOCK_CHECKPOINT_S3_KEY_PREFIX`;
- optional strict booleans `AGENT_DOCK_CHECKPOINT_S3_FORCE_PATH_STYLE` and
  `AGENT_DOCK_CHECKPOINT_S3_ALLOW_INSECURE_ENDPOINT`;
- optional `AGENT_DOCK_CHECKPOINT_S3_MAX_ATTEMPTS` from 1 through 10.

There is deliberately no AgentDock-specific access-key or secret variable. The
AWS SDK standard credential provider chain supplies IAM roles, Web Identity, or
standard AWS credential environment variables. Plain HTTP requires explicit
opt-in and is intended only for a private development endpoint. Bucket creation,
encryption, lifecycle, replication, IAM, and credential rotation stay outside
the application.

Run the real compatibility and host-independence proof with:

```bash
npm run object-store:check
```

It starts a digest-pinned MinIO fixture on an ephemeral loopback port with no
volume, creates a bucket, writes through one S3 client, destroys it, and restores
through another. It also proves no-overwrite publication, database-hash
corruption detection, and hard object-size rejection. The fixture is not a
production deployment recommendation.

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
does not start a local Docker supervisor or opt into the remote worker
composition. The explicit factory is available to a deployment that can supply
the required trusted adapters. The S3 factory is exported for the Supervisor
host rather than silently changing the HTTP-only entry point.

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
SSE, and `Last-Event-ID` replay. It also concurrently accepts four same-session
followers while the first input is running, forces tied timestamps, and proves
FIFO/no-overlap plus idempotent replay without a mailbox gap. Cancellation
coverage includes queued rejection,
idempotency, competing requests, natural-completion races, post-ACK failure
quarantine semantics, native Pi abort, forced POSIX descendant termination, and
SSE terminal delivery. Its default end-to-end path starts pinned Pi against the
loopback fake model without provider tokens. The opt-in Docker case additionally
persists and streams the ten-event Java repair and final patch.

The remote composition test starts a real Nest/Fastify listener and outbound
WebSocket Supervisor without manually invoking a dispatcher. It proves
capacity-capped lane creation, automatic execute, cancellation while execute is
waiting, maintenance progress, safe retry observations, no overlapping timer
callbacks, rejection of a late discovery result during drain, idempotent
shutdown, active-socket close, and refusal of new upgrades.

The local supervisor also has a crash-safe file event spool. A PostgreSQL
integration test commits an event, drops the returning ACK path, releases the
lease during terminal failure handling, constructs a fresh spool store, and
redelivers the exact event. PostgreSQL returns a duplicate-safe ACK and retains
one row. The ephemeral browser demo uses the same file-spool implementation;
its PGlite database and spool directory are deliberately temporary.

`PGlite` is test-only. `src/main.ts` uses the production `pg`/Kysely client and
requires the database plus Supervisor enrollment/management configuration; it
has no process-wide tenant/default profile and mounts no tenant API token.
Database migration, initial bootstrap, and privileged offline
tenant/credential administration remain explicit deployment steps. Optional
self-registration is a capacity-bounded loopback demonstration surface, not a
replacement for operator credential recovery or a public identity provider.
The continuously running remote worker,
authenticated Supervisor transport, and in-flight lease/assignment
reconciliation are composed in production. Generic repository restore, public
identity federation, mTLS for multi-host placement, policy-approved arbitrary
extensions, and a real model gateway are not claimed by this slice.

To run the identical HTTP suite against an empty real PostgreSQL database, set
`AGENT_DOCK_TEST_DATABASE_URL`. The value is consumed as configuration and is
never printed by the test.
