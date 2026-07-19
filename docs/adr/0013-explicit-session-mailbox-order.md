# ADR-0013: Explicit per-session mailbox order and queued follow-up semantics

- Status: Accepted
- Date: 2026-07-19

## Context

AgentDock already stores each turn and command before returning `202`, permits
several queued turns for one session, and prevents more than one active normal
turn. The dispatcher currently approximates mailbox order with
`(created_at, UUID)`. PostgreSQL timestamps can tie, while random UUID order is
unrelated to API acceptance order. Five rapidly accepted inputs can therefore
appear ordered in ordinary tests without having a strict database invariant.

The product semantics are also ambiguous when a user submits a prompt while a
turn is running. It could mean “queue another turn” or “steer the current model
loop”. These operations have different context, cancellation, retry, and UI
behavior and must not share an implicit interpretation.

## Decision

1. Every `turn.execute` command receives an immutable positive
   `mailbox_position`, monotonically increasing within its session. The session
   owns `next_mailbox_position` as its allocation counter.
2. Turn acceptance locks the session row, validates that the session can accept
   work, snapshots the model, inserts turn/command/outbox, increments the
   counter, and returns the allocated position in one transaction. A duplicate
   idempotency key returns the original position; a conflicting request creates
   neither a position gap nor another turn.
3. The dispatcher chooses the lowest nonterminal execute-command position for
   a session. Pre-ACK retry retains the same position and blocks every later
   execute command. Timestamp and UUID order are no longer correctness inputs.
4. A prompt accepted while another turn is active is a **queued follow-up**. It
   creates a new turn and later starts from the most recent successful settled
   Pi/workspace checkpoint. It never modifies or injects text into the current
   model request.
5. **Steer** remains a separate, unimplemented operation. It will require an
   explicit public request/command type and capability check against the active
   runtime; the prompt endpoint must not silently become steer.
6. Cancellation remains a targeted control path for the current acknowledged
   turn. It does not consume an execute mailbox position or wait behind future
   prompts. Approval resolution follows the same control-command principle.
7. New queued prompts are accepted only while a session is `cold`, `idle`,
   `running`, `waiting_approval`, or `cancelling`. `failed`, `recovering`, and
   `evicting` sessions reject new prompts until their explicit lifecycle work
   completes.
8. A forward migration backfills existing execute commands in their previous
   deterministic order, advances every session counter, enforces one positive
   position per execute command, and adds a unique per-session index. Non-execute
   commands must keep a null position.
9. Queue depth quotas and tenant fairness are later scheduling controls. Queued
   rows consume database storage only; they do not reserve a Pi process,
   sandbox, thread, or execution lease.

## Consequences

- Five accepted prompts have a visible, durable order that survives dispatcher
  concurrency, retries, process restarts, and tied timestamps.
- Concurrent HTTP requests are ordered by acquisition of the session row lock;
  the returned mailbox position is the authoritative result. Network arrival
  time is not claimed as a globally observable total order.
- The Web UI can show and enqueue follow-ups while the current turn runs without
  implying that the active model loop was steered.
- Session-row contention is introduced at prompt acceptance. This is the
  intended serialization point for one logical mailbox and is measurable before
  considering a different allocator.
- Cancellation remains responsive even when many prompts are queued.

## Rejected alternatives

### Continue ordering by timestamp and UUID

It is deterministic after rows exist but is not acceptance order when
timestamps tie. A passing five-request test would not establish the invariant.

### Use a process-local counter

Multiple API replicas and process restarts would allocate duplicates or reorder
commands. PostgreSQL already owns the session mailbox state.

### Treat every active-session prompt as steer

Pi may already be executing a tool or waiting for an approval. Silent steer
would create timing-dependent context and retry behavior and would not survive
cold activation in the same way as a queued turn.

### Route cancellation through the execute FIFO

A cancellation behind four future prompts would be operationally useless and
could not stop the currently running turn.
