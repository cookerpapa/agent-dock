# AgentDock database

This package owns the typed PostgreSQL schema and Kysely migrations for the
control plane. It does not store Pi conversation history or provider credential
values.

## Initial schema

The first migration creates 18 application tables covering:

- tenant, user, project, and workspace ownership;
- opaque credential bindings and allowlisted model profiles;
- sessions, queued/executing turns, and agent nodes;
- sandboxes and current fenced session leases;
- durable commands and idempotency keys;
- approvals;
- sequenced events and cumulative durable ACK cursors;
- transactional outbox rows;
- object-storage artifact metadata;
- token and cost usage ledger rows.

Important database-enforced invariants include:

- unique `(session_id, idempotency_key)` commands;
- a positive, immutable-in-practice execute-command mailbox position, unique per
  session, with non-execute control commands required to keep it null;
- a positive per-session next-position counter used as the transactional
  allocation point;
- unique `(session_id, seq)` events and globally unique event IDs;
- versioned credential-binding rows that preserve historical turn snapshots
  across credential rotation;
- many queued turns but at most one dispatching/running/waiting/cancelling turn
  per session;
- tenant-consistent composite foreign keys;
- positive fencing tokens and bounded sandbox capacity;
- cumulative event ACK not beyond the last persisted sequence;
- approval outcome/timestamp consistency;
- closed state, model-thinking, artifact-kind, and command-kind values;
- non-negative usage/cost values;
- no access token, refresh token, API key, or raw Pi message column.

The application state machines remain responsible for transition order. A
CHECK constraint can reject an unknown state, but it cannot replace the
transactional transition functions in `@agent-dock/domain`.

## Commands

Apply all migrations to a configured PostgreSQL database:

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

Roll back one migration explicitly:

```bash
DATABASE_URL=postgresql://... npm run db:migrate:down
```

The CLI never prints `DATABASE_URL`.

## Tests

`npm test --workspace @agent-dock/database` compiles the Kysely migration with
the PostgreSQL dialect and executes the resulting DDL in an isolated in-memory
PGlite PostgreSQL engine. The suite inserts both valid and invalid rows to prove
the constraints, then applies the down migration. PGlite is test-only; the
runtime client uses `pg` and a normal PostgreSQL server.
