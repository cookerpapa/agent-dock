# Web UI direction

## Design reference

PiCloud uses a familiar conversation product shell: account entry first, a
left conversation list, a right conversation, and an anchored composer. Inside
the transcript and optional Workspace inspector it retains the restrained visual
language of Pi's `/export` HTML. The pinned Pi `0.84.1` export templates and the
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

## PiCloud adaptations

PiCloud must use the visual language without copying the local-only execution
model. The browser never starts Pi directly, rewrites JSONL, or manages OS
processes. It talks only to the control-plane REST/SSE contract.

The product page adds:

- session state and reconnect/replay status;
- no model picker or credential form; platform model policy is an operator
  concern;
- streamed assistant text and tool lifecycle from `PiCloudEvent`;
- inline approval cards for confirm/select/input/editor;
- a visible turn-cancel control and clear cancelling/failed states;
- compact sandbox/runner health details for debugging;
- an event sequence indicator useful for demonstrating durable SSE replay.

Raw Pi runtime events, lease secrets, credential references, and provider tokens
must never appear in the DOM or browser developer logs.

## Deliberately omitted behavior

The current product does not expose Web Preview, structured Diff, Artifact or
test-result navigation, Workspace rollback, GitHub App/PR delivery, or
organization, RBAC and audit-search pages. Their unfinished routes and browser
client methods were removed rather than presented as a partial product.
Conversation forks, recursive tree deletion, tail pruning, Workspace browsing,
the brokered terminal and active Pi steer are supported.

## Visual acceptance

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
shows tenant-scoped named conversations, typed Subagent children and a
focused/full Pi Session tree at left, with the selected transcript at right.
Starting a conversation requires selecting an existing named Workspace or
creating a new empty one. The browser has no repository-import workflow. No API
token, provider key, model profile, or model picker is shown to an ordinary
user.

The transcript preserves event order, merges adjacent text deltas, renders
Markdown without raw HTML or remote-image fetches, collapses tool input/output,
and shows approval and terminal cards. The narrow layout turns the conversation
sidebar into an overlay with an explicit backdrop.

The browser uses only relative REST/SSE routes. Its fetch-based SSE client can
set `Last-Event-ID` explicitly, parses fragmented frames, validates the shared
`PiCloudEvent` contract and frame identity, refuses sequence gaps, ignores
duplicates, and reconnects with bounded backoff. Public REST resources are also
validated before they enter React state. No raw Pi object, credential reference,
provider token, or API body is logged.

The one-command demo uses the supported persistent production topology. The
trusted Worker commits Pi Session state to PostgreSQL before completion is
published. A follow-up can run on any eligible Worker and reuses the Session's
persistent Cube Volume and, when still warm, its Cube activation. The composer remains
available during an active turn: another prompt is visibly queued as a separate
follow-up, receives and displays its durable mailbox position, and never implies
that it steered the running model loop. Storage identities and platform
credentials never enter browser-visible contracts.

## Implemented Workspace directory

The responsive right side is a directory view of the current committed
`/workspace`, not an operations dashboard. It loads only Workspace versions,
files and the selected file body. Operational Runs, usage and environment
diagnostics remain in telemetry/admin APIs, so a denied unrelated request
cannot blank or repeatedly reload the directory.

Preview is deliberately inert: at most 512 KiB of valid UTF-8 is rendered in an
escaped `<pre>`, binary data is labelled, and repository HTML/scripts are never
embedded. The same panel offers a brokered xterm session without exposing Cube
ports or credentials. Deleting a parent recursively archives its human and
Subagent descendants. Tail pruning retains the selected final answer and moves
Pi's active lane back to it; neither operation rolls back Workspace bytes.

A dedicated platform administrator bypasses the conversation shell and lands
on the settings page for model and Cube proxy configuration. Tenant owners
remain ordinary conversation users.
