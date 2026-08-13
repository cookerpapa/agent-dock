# Workspace revisions

One Workspace maps to one stable persistent Cube Volume. A revision records a
bounded file/hash index, trusted external Git baseline/patch, environment
identity and fence. It does not contain another copy of the Workspace bytes.

The trusted Volume envelope is:

```text
volume root
├── platform generation/state
├── external Git metadata
└── workspace/        <- the only subtree mounted into Cube as /workspace
```

Multiple conversations may use the same Workspace, but only one writable Run
may own it at a time. A terminal commit advances the Workspace revision only
when the expected base revision and current fence still match.

The source browser reads the current persistent Volume and verifies the selected
file's recorded digest. If it changed since the requested revision, the client
must refresh rather than receiving bytes mislabeled as historical state.

Normal Run settlement is not a backup system. Historical rollback/fork requires
an explicit snapshot facility from the selected storage backend and is outside
the current default product path.
