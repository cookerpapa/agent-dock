# AgentDock Web UI

This workspace contains the Phase 1 Pi-`/export`-inspired React session page. It
uses only the public control-plane REST and SSE contracts; it never reads Pi
JSONL, launches a process, talks to Docker, or receives a provider credential.

## Behavior

- creates the sample project/session and durably submits Java repair turns;
- streams ordered assistant/tool/approval/terminal events;
- reconnects with explicit `Last-Event-ID` and suppresses replay duplicates;
- exposes cancellation only after the execution start event;
- renders the bounded final unified diff;
- displays session, turn, connection, sandbox, and sequence state in text as
  well as color;
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
- exposes a Session inspector for immutable Workspace history, escaped file and
  Artifact previews, structured compare, Run/Attempt transitions, tests,
  usage/context, and owner-only operational activity;
- supports fork, rollback, archive, and retry-as-new-Run through idempotent
  public API operations;
- supports exact-commit GitHub App repository selection and explicit
  branch/commit/Check/Pull Request delivery when an operator configures the
  trusted GitHub Gateway.

All API resources and events are validated with `@agent-dock/protocol`. Markdown
raw HTML is disabled by default, remote images are replaced with inert labels,
unknown tool values are rendered as bounded text, and Workspace/Artifact
preview is escaped UTF-8 text capped at 256 KiB. Binary content is labelled and
never embedded as active content. The client does not write request bodies,
events, tokens, or credential references to the console.

## Run and verify

From the repository root, the complete zero-token flow is:

```bash
npm run demo
```

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

Settled checkpoints permit later turns on the same Session and restore Pi JSONL
plus the bounded Workspace into a new disposable Sandbox. Recent discovery
survives a page reload after the user presents the token again. Arbitrary Git
URLs, executable live previews, project extensions, public identity recovery,
and Internet-facing anonymous SaaS remain excluded.
