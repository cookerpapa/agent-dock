# AgentDock control plane

This package contains the first Phase 1 NestJS/Fastify vertical slice. It is a
single-user HTTP intake boundary, not yet the Pi executor or browser event
surface.

## Implemented endpoints

- `POST /v1/projects` creates a project and its initial workspace atomically.
- `POST /v1/projects/:projectId/sessions` creates a cold session using the
  operator-configured default model profile.
- `POST /v1/sessions/:sessionId/turns` requires `Idempotency-Key` and returns
  `202 Accepted` only after the queued turn, pending command, and transactional
  outbox record commit together.

The turn stores the prompt and immutable model/credential-binding snapshot. The
command stores only a request fingerprint, and the outbox carries IDs rather
than copying the prompt or any credential material. Repeating the same key and
request returns the original acceptance; reusing the key for different content
returns `409`.

## Verification boundary

```bash
npm run test --workspace @agent-dock/control-plane
```

The test starts official PGlite behind its PostgreSQL wire-compatible socket,
runs the Kysely migration, creates the NestJS application, and sends real
Fastify HTTP requests without opening a public port. It covers validation,
durable acceptance, idempotent replay, conflicting reuse, model-policy rejection,
generic error redaction, and rollback when the outbox step fails.

`PGlite` is test-only. `src/main.ts` uses the production `pg`/Kysely client and
requires `DATABASE_URL`, `AGENT_DOCK_TENANT_ID`, and
`AGENT_DOCK_DEFAULT_MODEL_PROFILE_ID`. Database migration and operator bootstrap
remain explicit deployment steps. Turn dispatch, Pi execution, SSE, cancellation,
and the React page are not claimed by this slice.

To run the identical HTTP suite against an empty real PostgreSQL database, set
`AGENT_DOCK_TEST_DATABASE_URL`. The value is consumed as configuration and is
never printed by the test.
