# ADR-0109: PostgreSQL SessionStorage as the sole conversation store

## Status

Accepted on 2026-08-15.

## Context

Pi conversations were once copied from a Worker-local JSONL file into
content-addressed segments and an object-store manifest. After the PostgreSQL
SessionStorage cutover, the Workspace schema still required a Pi artifact and
Session object-store pointer. The resulting synthetic reference was never read
to restore model context and made pure chat perform unnecessary writes.

## Decision

1. PostgreSQL Pi SessionStorage is the only model-context authority.
2. Remove JSONL segmentation, manifests, reconstruction, compatibility readers
   and their benchmark.
3. Remove synthetic Pi artifacts, `pi_session_snapshot_key`, the Run base Pi
   artifact pointer and the Workspace-version Pi artifact foreign key.
4. The Workspace checkpoint loader restores only filesystem state.
5. Conversation state never enters the bounded PostgreSQL object rows used for
   Workspace seeds and oversized Tool output. Those objects are separate from
   Pi SessionStorage and from the persistent Workspace Volume authority.

## Consequences

- Conversation size no longer affects object-store checkpoint traffic.
- Pure chat does not write a synthetic checkpoint object.
- Compaction and cross-Worker recovery use Pi-native PostgreSQL entries.
- Workspace versions model only filesystem state.
