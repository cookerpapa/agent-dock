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

A version references exact Pi transcript and canonical Workspace snapshot
artifacts plus an optional unified patch. SHA-256 and byte length are checked
after bytes cross the authenticated Supervisor artifact transport. Browser
requests use tenant-owned UUIDs; browsers never submit object-store keys.

## User operations

- list version history and the current pointer;
- list files or download one manifest-selected file;
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

## Consistency claim

The implementation provides immutable version history, fenced staged commit,
and CAS-protected user pointer changes. It does not claim exactly-once shell
execution or object upload. Objects are content-verified, while stale Attempts
cannot settle a version or overwrite the Session's current pointer.

