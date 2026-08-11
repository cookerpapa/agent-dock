# ADR-0071: SDK-only Pi runtime and current-format-only restores

Status: accepted

## Context

AgentDock completed two production cutovers:

- trusted Pi Workers now run the public embedded Pi SDK directly;
- Pi conversation checkpoints now use content-addressed JSONL segments and the
  compressed `agent-dock.pi-session-manifest.v3` manifest.

The repository nevertheless retained a complete Pi RPC subprocess runner,
environment-configured extension entrypoint, RPC-only UI adapter and spike.
The production Runner also exposed an execution-mode switch whose default was
the superseded RPC path. Checkpoint loading similarly accepted an untyped
whole-file object when the current manifest media type was absent.

Those branches doubled the executable and test surface, obscured the actual
security model and allowed a missing deployment variable to select an
unmaintained runtime.

## Decision

Pi SDK execution is the only supported Agent Loop:

- every Pi Worker runs a bounded set of independent `PiSdkTurnRunner` slots;
- Tool implementations are registered as activation-local inline extensions;
- shared errors, cancellation, checkpoint and event contracts use neutral
  `Pi*` names rather than `PiRpc*`;
- there is no execution-mode environment variable, subprocess runner,
  environment-configured Tool extension, or RPC compatibility spike.

Conversation restore accepts only the current manifest media type and pinned Pi
version. Older development snapshots fail closed with
`checkpoint_incompatible`; no migration reader remains.

Implementation logs and completed backlog entries remain as decision history.
They are not executable compatibility promises.

## Consequences

- A missing environment variable can no longer reactivate the old runtime.
- Pi SDK isolation is provided by a replaceable Worker process (one Pod in
  Kubernetes); an SDK isolation failure poisons and retires that Worker and
  its bounded active slots resume from committed state.
- Upgrading Pi or the checkpoint format requires an explicit new decision,
  migration and contract test.
- Existing development data written in the old whole-file format must be
  discarded instead of silently imported.
