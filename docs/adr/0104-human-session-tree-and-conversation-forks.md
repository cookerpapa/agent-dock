# ADR-0104: human session tree and conversation forks

Status: accepted

## Context

Pi 0.84 stores a Session as immutable entries linked by `parentId`, with a
lane pointing at the active leaf. PiCloud already persists that model in
PostgreSQL through Pi's public `SessionStorage` interface, but the product UI
only exposes a flat list of Sessions and a flat list of user prompts.

Users need to inspect earlier decisions, jump within a long conversation and
start an alternative continuation from a settled assistant response. This is
a human product workflow. It must not yet let the model enumerate or move
branches, and it must not add the full tree to the model context.

## Decision

PiCloud adopts Pi's `/fork` product semantics:

- a fork starts at a settled, final assistant entry;
- it creates a new product Session and a new Pi Session;
- the new Pi Session records copy-on-write references to the selected
  root-to-leaf branch rather than copying immutable JSON payloads;
- referenced entries keep their Pi entry IDs and parent links, while the child
  has a fresh append sequence and no inherited open operation records;
- the child continues to use the same Workspace as its parent. The fork changes
  conversation context; it does not rewind Workspace bytes;
- Workspace serialization and Tool fencing remain unchanged.

Product Sessions record their parent Session, fork Turn and fork Pi entry. A
tree endpoint returns an PiCloud-owned, bounded projection of user and final
assistant nodes. It supports a current-branch view and a whole-family view.
Pi entry payloads remain an internal storage detail.

Fork creation is transactional and idempotent. The child product Session,
event cursor, referenced Pi branch and fork operation commit together. A child
conversation renders the inherited product transcript followed by its own
Turns, while live SSE resumes only from the child Session's event cursor.

The browser presents two independent left panels: the conversation list and
the selected conversation tree. Each panel is collapsible and horizontally
resizable. A settled final assistant message offers “从此对话开始”.

## Invariants

1. Only a final assistant entry belonging to a completed canonical Turn can be
   forked.
2. A model cannot provide Session IDs, entry IDs, lane names or tree movement
   commands.
3. Forking never copies Workspace bytes and never creates a second Workspace
   authority.
4. A child Session never inherits an open Pi operation record.
5. Cross-tenant parents, entries and descendants are invisible and invalid.
6. The current-branch view trims an ancestor at the entry from which its next
   child was forked; the whole-tree view preserves every continuation.
7. Archived or active/unsettled source Sessions cannot be forked.

## Consequences

Forks duplicate the selected Pi entry branch inside PostgreSQL. This is a
bounded, local database copy rather than a full JSONL download or an object
store checkpoint. It keeps the production Pi runtime unchanged: each child is
still opened on its `main` lane by the existing Worker.

All branches share one logical Workspace and therefore one writable execution
slot. When a branch first invokes a tool, Tool Broker retires an ordinary warm
activation owned by another branch before reserving the new activation. A
persistent activation may be transferred only when PostgreSQL proves that both
Sessions belong to the same conversation tree. The old process world is stopped
and its durable reservation is released; files continue from the authoritative
Workspace revision, while background processes do not migrate between branches.

Workspace files reflect the latest shared Workspace state, not historical file
state at the fork point. The UI states this explicitly. Historical Workspace
fork/rollback remains a separate product concern.

Runtime-native tree navigation, branch summaries and model-visible tree tools
are intentionally deferred until they have their own authority, context-budget
and safety design.
