# Temporal Run orchestration spike

This isolated spike evaluates the official Temporal TypeScript SDK as a
possible replacement for AgentDock's post-admission PostgreSQL Run dispatcher.
It is deliberately not a second production scheduler.

It starts the pinned Temporal CLI development server, two independent polling
Worker processes, and one bounded Workflow per synthetic AgentDock Run. The
probe verifies:

- Task Queue load balancing across two capacity-one Workers;
- Activity heartbeat, cancellation, and confirmed cleanup;
- Worker `SIGKILL` followed by retry on the surviving Worker with a newer
  fencing token;
- Temporal service restart with a persistent development database;
- idempotent Workflow IDs;
- a bounded Workflow history containing references rather than prompt,
  credential, Pi JSONL, Tool output, or Workspace bytes.

Run:

```bash
npm run spike:temporal
```

The script downloads Temporal CLI `1.8.1` from the official GitHub release into
the user's cache and verifies its published SHA-256 before execution. The
embedded development server is evaluation-only; production adoption would use
the pinned Temporal Server and official Helm chart with backup, upgrade, TLS,
authentication, and visibility-store runbooks.

The Pi agent loop itself remains outside Workflow code. A real Pi Run is
non-deterministic and belongs in a cancellable Activity; Tool execution still
requires AgentDock Tool Call IDs, fencing, Workspace CAS, and explicit
`UNKNOWN` handling for ambiguous side effects.
