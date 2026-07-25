# ADR-0054: Horizontal Pi Worker pool and native session checkpoints

- Status: accepted
- Date: 2026-07-25
- Supersedes: ADR-0023's single fixed Supervisor identity and fixed management
  URL

## Context

The durable Control Plane already discovers every active Supervisor WebSocket
connection and creates a bounded set of execution/cancellation lanes for each
connection. Production nevertheless deployed one `supervisor-host` container
with two in-process slots. Boot enrollment allowed one exact Supervisor ID, the
Control Plane called one fixed management URL, and two replicas would have
shared the same boot ledger and event spool. Those deployment assumptions made
the existing multi-connection scheduler impossible to use safely as a fleet.

Pi session recovery also needs a precise contract. Reconstructing a fresh
`messages[]` array from relational chat rows would lose Pi session-tree entries,
model/thinking changes, tool messages, compaction boundaries, and
`firstKeptEntryId`. Pi already defines an append-only JSONL session format and
knows how to rebuild the active model context from it.

## Decision

1. A trusted Pi Worker is an independently deployable process with a unique,
   DNS-label-compatible `supervisorId`, fresh `bootId` and `sandboxId`,
   independent persistent boot ledger, and independent durable event spool.
2. Workers authenticate and connect outbound to the Control Plane. The Control
   Plane creates at most `min(worker capacity, lane limit)` execution lanes per
   active connection. No Session has a permanent Worker affinity; the durable
   RunAttempt lease selects an available connection when a Run becomes active.
3. Enrollment authorizes a bounded operator-configured Supervisor ID prefix,
   not one exact ID. Capacity remains capped centrally.
4. Every Worker advertises its private management base URL during authenticated
   enrollment. The Control Plane accepts it only when it exactly matches the
   operator template after substituting the validated Supervisor ID. The
   validated URL is stored with the Supervisor host identity and retirement
   traffic is routed to the exact owner. This preserves exact-boot stop proof
   without allowing a Worker-controlled SSRF target.
5. Artifact reads no longer traverse an arbitrary Worker. The Control Plane
   reads immutable checkpoint/artifact objects directly from the shared
   S3-compatible store.
6. The bundled production topology runs two independent Worker containers.
   Adding or removing Workers changes aggregate capacity without moving
   database/session state. Each Worker drains on SIGTERM before its process
   exits.
7. PostgreSQL stores normalized conversation projections for the product UI,
   searchable metadata, events, usage, and compaction audit metadata. These
   rows are not the authoritative Pi resume format.
8. At a settled Run boundary, the active Worker reads the complete Pi-native
   `session.jsonl`, uploads it as an immutable checkpoint object, and atomically
   advances checkpoint metadata together with the Run settlement protocol.
9. A later Run may be assigned to any Worker. That Worker downloads the latest
   committed Pi JSONL checkpoint, writes it to a private temporary session file,
   starts pinned Pi RPC with `--session <file>`, and lets Pi rebuild its active
   context.
10. Pi compaction remains native. The full pre-compaction history and the
    appended `compaction` entry stay in JSONL; Pi uses the summary,
    `firstKeptEntryId`, and recent entries to construct the next model
    `messages[]`. AgentDock stores a separate, non-secret compaction audit row
    but does not attempt to regenerate the summary.

## Consequences

- Worker processes are horizontally replaceable because durable conversation,
  Workspace, Run, event, and usage state lives outside them.
- Scaling Worker replicas increases active Run capacity; it does not create a
  permanent Pi process for every historical Session.
- A complete JSONL snapshot is uploaded at every settled Run. This duplicates
  bytes compared with an incremental log, but preserves Pi's exact native
  semantics and keeps restore atomic. Content-addressed/incremental checkpoint
  optimization may be added later without changing the logical contract.
- Relational conversation projections may be rebuilt from durable events, but
  they cannot replace the Pi checkpoint for resume.
- A Worker enrollment credential remains powerful and must be distributed only
  to trusted Worker nodes. URL-template validation limits where the Control
  Plane can send management credentials.

## Executable evidence

- protocol and boot-provisioning tests admit two independent Worker IDs and
  reject identity-prefix or management-URL spoofing;
- remote runtime tests create independent bounded dispatch lanes for two
  simultaneous Worker connections;
- production Compose starts two Workers with separate boot/spool volumes;
- Pi integration tests force native threshold compaction, verify the
  `compaction` entry and public compaction events, then restore the JSONL into a
  fresh Pi RPC process and continue the conversation.
