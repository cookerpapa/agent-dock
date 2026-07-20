# Web UI direction

## Design reference

AgentDock uses a familiar conversation product shell: account entry first, a
left conversation list, a right conversation, and an anchored composer. Inside
the transcript and optional Workspace inspector it retains the restrained visual
language of Pi's `/export` HTML. The pinned Pi `0.80.10` export templates and the
owner's earlier Pi Session Tree Browser were reviewed as local, read-only design
references. No private session transcript was inspected or copied.

The reference qualities to preserve are:

- compact monospace typography (roughly 12 px text with an 18 px rhythm);
- a dark, theme-variable-driven page rather than hard-coded colors;
- a compact dark conversation sidebar with clear active-session emphasis and
  account controls;
- a centered transcript column around 800 px wide;
- restrained user-message cards and mostly unboxed assistant prose;
- readable Markdown, syntax-highlighted code, images, and tables;
- collapsible thinking and tool details so operational output does not dominate
  the answer;
- timestamps and session/model metadata that remain visually secondary;
- responsive sidebar overlay behavior on narrow screens.

The existing Session Tree Browser also demonstrates useful live behavior:
independent transcript/sidebar scrolling, an anchored composer, streamed output,
runtime state, fork navigation, and bounded/idle runtime management.

## AgentDock adaptations

AgentDock must use the visual language without copying the local-only execution
model. The browser never starts Pi directly, rewrites JSONL, or manages OS
processes. It talks only to the control-plane REST/SSE contract.

The product page adds:

- session state and reconnect/replay status;
- no model picker or credential form; platform model policy is an operator
  concern;
- streamed assistant text and tool lifecycle from `AgentDockEvent`;
- inline approval cards for confirm/select/input/editor;
- a visible turn-cancel control and clear cancelling/failed states;
- compact sandbox/runner health details for debugging;
- an event sequence indicator useful for demonstrating durable SSE replay.

Raw Pi RPC payloads, lease secrets, credential references, and provider tokens
must never appear in the DOM or browser developer logs.

## Deferred behavior

Automatic next-question loops, arbitrary provider/model URLs, branch deletion,
live execution previews, and advanced session-tree editing remain deferred.
Fork, rollback, archive, bounded model selection, and GitHub PR delivery now
exist through explicit product operations.

## Phase 1 visual acceptance

- A long Pi-style transcript remains readable without full-width chat bubbles.
- Tool and thinking blocks can be expanded and collapsed with keyboard access.
- Sidebar and transcript scroll independently on desktop; sidebar becomes an
  overlay on small screens.
- A disconnected SSE client visibly reconnects and resumes without duplicating
  rendered events.
- Session, turn, approval, and failure states are distinguishable without
  relying on color alone.

## Implemented conversation product

`packages/web-ui` now enters through username/password login or registration and
restores a durable HttpOnly-cookie session on reload. The authenticated shell
shows tenant-scoped recent conversations at left and the selected transcript at
right. Sending the first message lazily provisions an empty Workspace;
importing a fixture or exact GitHub commit is an explicit separate action. No
API token, provider key, model profile, or model picker is shown to a normal
user.

The transcript preserves event order, merges adjacent text deltas, renders
Markdown without raw HTML or remote-image fetches, collapses tool input/output,
and shows approval and terminal cards. The narrow layout turns the conversation
sidebar into an overlay with an explicit backdrop.

The browser uses only relative REST/SSE routes. Its fetch-based SSE client can
set `Last-Event-ID` explicitly, parses fragmented frames, validates the shared
`AgentDockEvent` contract and frame identity, refuses sequence gaps, ignores
duplicates, and reconnects with bounded backoff. Public REST resources are also
validated before they enter React state. No raw Pi object, credential reference,
provider token, or API body is logged.

The one-command local demo can still use a deterministic model and image-owned
Java fixture. After each successful turn, the trusted host stores Pi JSONL and a
bounded workspace manifest before completion is published. A follow-up on the
same session restores both into a new disposable container, so the composer can
honestly remain available after settlement. The composer now also remains
available during an active turn: another prompt is visibly queued as a separate
follow-up, receives and displays its durable mailbox position, and never implies
that it steered the running model loop. S3-compatible checkpoint storage
remains below the UI and never exposes object keys or raw storage credentials to
the browser.

## Implemented product inspector

Milestone 7 adds a responsive right-side Session inspector while preserving the
Pi-export-inspired transcript. Its tabs present immutable Workspace history,
structured compare, files, Artifacts, durable Run/Attempt transitions, tests,
tenant/run usage, context compaction, owner metrics, and a derived execution
activity feed. Fork/rollback/archive and retry-as-new-Run are idempotent public
API actions; terminal history is never rewritten.

Preview is deliberately inert: at most 256 KiB of valid UTF-8 is rendered in an
escaped `<pre>`, binary data is labelled, and repository HTML/scripts are never
embedded. The optional GitHub App workflow lets an owner synchronize an
installation, choose only an enabled exact-commit repository, and explicitly
deliver the selected Workspace version as branch/commit/Check/Pull Request
through the trusted Gateway. With no configured App, the server fails closed.
