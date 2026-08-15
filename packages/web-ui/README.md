# AgentDock Web UI

This workspace contains the Phase 1 Pi-`/export`-inspired React session page. It
uses only the public control-plane REST and SSE contracts; it never reads Pi
JSONL, launches a process, talks to Kubernetes/containerd, or receives a
provider credential.

## Behavior

- creates or selects a named Workspace and durably submits Pi turns;
- streams ordered assistant/tool/approval/terminal events;
- reconnects with explicit `Last-Event-ID` and suppresses replay duplicates;
- exposes cancellation only after the execution start event;
- provides a keyboard-resizable desktop tree and mobile sidebar overlay.
- verifies a pasted tenant credential through `/v1/identity`, displays the
  tenant/user/role, keeps the token only in memory, clears session state on
  logout, and disables mutation controls for `viewer`.
- offers opt-in tenant registration, verifies the one-time owner token before
  switching security context, and never stores that token in Web Storage or a
  URL;
- lists only the authenticated tenant's recent conversations, loads bounded
  prompt history, and resumes the matching durable SSE suffix when a user
  switches sessions;
- exposes an expandable committed Workspace directory and inert source-file
  preview;
- supports conversation archive/delete and active Pi steer through idempotent
  public API operations.

All API resources and events are validated with `@agent-dock/protocol`. Markdown
raw HTML is disabled by default, remote images are replaced with inert labels,
unknown tool values are rendered as bounded text, and Workspace/Artifact
preview is escaped UTF-8 text capped at 256 KiB. Binary content is labelled and
never embedded as active content. The client does not write request bodies,
events, tokens, or credential references to the console.

## Run and verify

From the repository root, start the supported persistent loopback product:

```bash
npm run demo
```

This is an alias for `npm run production:deploy`; it does not start a separate
lower-security or browser-owned Agent runtime.

For frontend-only work, start a compatible API on `127.0.0.1:3100` and run:

```bash
npm run dev --workspace @agent-dock/web-ui
```

The production bundle, strict type check, and deterministic tests are:

```bash
npm run build --workspace @agent-dock/web-ui
npm run typecheck --workspace @agent-dock/web-ui
npm run test --workspace @agent-dock/web-ui
```

PostgreSQL SessionStorage permits later turns on the same Session while
Workspace checkpoints restore files into the Session's Cube activation. Recent discovery
survives a page reload after the user presents the token again. Arbitrary Git
URLs, executable live previews, Diff/Artifact/test navigation, Fork/Rollback,
GitHub PR delivery, organization/RBAC administration, public identity recovery,
and Internet-facing anonymous SaaS remain excluded from the Web product.
