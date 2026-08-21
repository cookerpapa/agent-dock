# PiCloud Web UI

This package is the browser product for PiCloud. It talks only to the public
REST, resumable SSE and brokered Terminal endpoints; it never opens Pi,
PostgreSQL, Cube or provider credentials directly.

## Current behavior

- username/password registration and HttpOnly-cookie login;
- tenant-scoped named Workspaces and conversations;
- resizable conversation list and focused/full Pi Session tree;
- typed, read-only Subagent child Sessions with context/Workspace-mode labels;
- ordered assistant, thinking and Tool rendering from durable SSE;
- active Turn cancellation and steer;
- conversation forks, recursive subtree deletion and settled-answer tail
  pruning;
- committed Workspace directory/source preview and a brokered xterm terminal;
- a separate administrator settings product for model and Cube proxy policy.

Tail pruning changes conversation context only. It retains the selected final
Assistant entry, hides later Turns/branches/Subagents and lets the next Pi Run
continue from that entry. Workspace files remain at their current revision.

All public resources and events are validated with `@pi-cloud/protocol` before
entering React state. Markdown raw HTML is disabled, remote images are inert,
unknown Tool values are bounded, and file preview accepts at most 512 KiB of
valid UTF-8. The browser never logs request bodies, events, tokens or credential
references.

## Verify

From the repository root:

```bash
npm run build --workspace @pi-cloud/web-ui
npm run typecheck --workspace @pi-cloud/web-ui
npm run test --workspace @pi-cloud/web-ui
```

The supported persistent product is started with `npm run production:up` (or
installed with `./install.sh`). Frontend-only development may point Vite at a
compatible loopback API using the package's existing `dev` command.
