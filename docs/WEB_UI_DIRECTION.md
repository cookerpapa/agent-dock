# Web UI direction

## Design reference

AgentDock's session page should feel like Pi's `/export` HTML rather than a
generic consumer chat application. The pinned Pi `0.80.10` export templates and
the owner's earlier Pi Session Tree Browser were reviewed as local, read-only
design references. No private session transcript was inspected or copied.

The reference qualities to preserve are:

- compact monospace typography (roughly 12 px text with an 18 px rhythm);
- a dark, theme-variable-driven page rather than hard-coded colors;
- a resizable session/tree sidebar with search, filters, active-path emphasis,
  role colors, and a compact status footer;
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

The first React session page should add:

- session state and reconnect/replay status;
- the fixed v0 model profile as read-only metadata, not a prominent picker;
- streamed assistant text and tool lifecycle from `AgentDockEvent`;
- inline approval cards for confirm/select/input/editor;
- a visible turn-cancel control and clear cancelling/failed states;
- compact sandbox/runner health details for debugging;
- an event sequence indicator useful for demonstrating durable SSE replay.

Raw Pi RPC payloads, lease secrets, credential references, and provider tokens
must never appear in the DOM or browser developer logs.

## Deferred behavior

Fork creation, branch deletion, automatic next-question loops, arbitrary model
selection, and advanced session-tree editing are not required for the first
vertical slice. The layout should leave room for them without delaying durable
turn submission, SSE streaming, cancellation, and recovery.

## Phase 1 visual acceptance

- A long Pi-style transcript remains readable without full-width chat bubbles.
- Tool and thinking blocks can be expanded and collapsed with keyboard access.
- Sidebar and transcript scroll independently on desktop; sidebar becomes an
  overlay on small screens.
- A disconnected SSE client visibly reconnects and resumes without duplicating
  rendered events.
- Session, turn, approval, and failure states are distinguishable without
  relying on color alone.
