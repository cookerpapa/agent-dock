# Workspace versions, files, artifacts, and delivery

## Implemented model

Each successful Coding Agent Run publishes one immutable `WorkspaceVersion`.
The checkpoint is first inserted as `staged` under the current Run/Attempt
fence. The same transaction that settles the Run changes it to `settled` and
advances `sessions.current_workspace_version_id`. A failed, cancelled,
superseded, or timed-out Attempt changes its staged version to `abandoned` and
restores the Session's pointers to the last settled version.

```text
Version 1 (settled)
  └─ Version 2 (settled, current)
       └─ Version 3 (staged while Run owns the fence)
```

A version references exact Pi transcript and canonical Workspace checkpoint
artifacts plus an optional unified patch. The checkpoint is either the legacy
portable regular-file manifest or an identity-bound Cube-native snapshot
reference with a content-hashed file index. SHA-256 and byte length are checked
after bytes cross the authenticated Supervisor artifact transport. Browser
requests use tenant-owned UUIDs; browsers never submit object-store keys.

## User operations

- list version history and the current pointer;
- list files from either checkpoint format; download exact file content from a
  portable manifest;
- compare two versions in the same Workspace by content/mode hash;
- download typed artifacts;
- fork a new cold Session from a selected version;
- roll a cold/idle Session pointer back with expected-version CAS;
- archive/unarchive an idle Session;
- inspect test commands derived from durable Bash tool events.

Fork, rollback, archive, and unarchive use durable idempotency keys and audit
rows. Active work blocks pointer-changing operations. Archived Sessions reject
new Turns. Rollback does not delete or rewrite history; the next Pi activation
loads the selected version's transcript and files.

Cube-native versions can be listed, compared, forked and rolled back without
booting a VM because the reference contains content hashes. Exact historical
file download and GitHub delivery currently fail with
`artifact_unavailable` unless a portable manifest/patch is available; a future
read-only Cube snapshot materializer will close that product gap.

## Consistency claim

The implementation provides immutable version history, fenced staged commit,
and CAS-protected user pointer changes. It does not claim exactly-once shell
execution or object upload. Objects are content-verified, while stale Attempts
cannot settle a version or overwrite the Session's current pointer.
