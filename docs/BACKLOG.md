# Initial backlog

Only the current phase should contain implementation work. Later phases remain
in `ROADMAP.md` until their prerequisites are complete.

## Phase 0

- [x] ADR-0001: TypeScript runtime language, sandbox boundary, and RPC-first Pi integration
- [x] ADR-0003: state ownership across PostgreSQL, Pi JSONL, object storage, and the event spool
- [x] ADR-0004: command idempotency, event sequence, lease, and fencing model
- [x] Research existing application-state, sandbox, and process-hibernation runtimes
- [x] ADR-0005: pluggable execution and recovery tiers
- [x] ADR-0006: single-user v0 scope, model profiles, and credential ownership
- [x] Create `spikes/pi-extension-compat/`
- [x] Pin a Pi version and start `pi --mode rpc --no-session` from a TypeScript supervisor
- [x] Add an unchanged sample extension with a `/cloud-check` command
- [x] Assert that `get_commands` discovers `/cloud-check`
- [x] Make `/cloud-check` call `ctx.ui.confirm()` and `ctx.ui.notify()`
- [x] Proxy `extension_ui_request` to a test client and return `extension_ui_response`
- [x] Verify clean cancellation and complete Pi child-process termination
- [x] Run the spike inside a non-root Docker container
- [x] Publish the initial extension compatibility matrix
- [x] Define the public AgentDock event envelope
- [x] Define supervisor registration, command, event, ACK, and heartbeat messages
- [x] Prove SDK rehydration of Pi messages and `appendEntry` extension state
- [x] Prove same-session FIFO and bounded cross-session SDK activations
- [x] Record that Pi JSONL becomes durable only after an assistant message exists
- [x] Add an explicit opt-in real-provider rehydration probe, including SDK HTTP
  bootstrap, excluded from CI
- [x] Model session, turn, sandbox, approval, and agent-node states
- [x] Create initial PostgreSQL schema and Kysely migrations
- [x] Create local hardened Docker Compose topology and configuration contracts
- [x] Implement deterministic fake model server
- [x] Script fake text streaming and tool-call scenarios
- [x] Script 429, timeout, malformed response, and stream-disconnect scenarios
- [x] Add CI for formatting, unit tests, and secret scanning

## First vertical-slice story

As a user, I can import a sample Java repository, create a session, ask the Pi
agent to repair a failing test, observe text and tool events in real time, cancel
the turn, and inspect the final Git diff.

Acceptance criteria:

- [x] The command is durably accepted before execution starts
- [x] A transactional-outbox dispatcher proves exclusive mailbox claim,
  pre-ACK retry, and post-ACK terminal failure with a deterministic backend
- [x] The supervisor uses a pinned Pi RPC process through an AgentDock adapter
- [x] Fenced events commit to PostgreSQL before cumulative supervisor ACK
- [x] Pi, built-in tools, and the sample workspace run outside the NestJS control-plane process
- [x] Text and tool events carry session, turn, agent, and sequence identifiers
- [x] SSE reconnect resumes from the last acknowledged event
- [x] Cancellation stops the model request and complete tool process tree on POSIX
- [x] The zero-token demo supplies no provider credential and exposes no fake key in container
  configuration, public events, or the final patch
- [x] A clean-checkout command reproduces the zero-token backend demo
- [x] A Pi-export-inspired React page renders the live flow

Policy-approved project extension loading was removed from the Phase 1 exit
criteria and remains a Phase 3 sandbox/approval deliverable. The Phase 1 image
loads only its trusted fixture and disables project extensions; treating that as
extension-policy support would overstate the current boundary.

## Phase 2: durable sessions and mailbox

- [x] ADR-0011: checkpoint-before-terminal boundary and semantic cold restore
- [x] Persist explicit Pi session JSONL instead of using `--no-session` when checkpointing
- [x] Define a closed, bounded, hashed private checkpoint publish/ACK protocol
- [x] Snapshot and safely restore the sample workspace without host bind mounts
- [x] Store artifact metadata and snapshot pointers under current lease/fence and revision CAS
- [x] Ignore a staged pointer unless its turn has a durable `turn.completed` commit marker
- [x] Prove a second same-session turn in a different container sees prior messages and files
- [x] Re-enable the Web composer for same-session follow-up turns
- [x] Add an immutable S3-compatible object store and prove fresh-client restore against MinIO
- [x] Make the supervisor event spool crash-safe and replay it after supervisor restart
- [x] Add transactional cross-replica live event notification with durable SSE fallback
- [x] Allocate an immutable positive execute-command mailbox position per session
- [x] Prove five queued same-session inputs preserve mailbox order with tied timestamps
- [x] Specify active-session prompts as queued follow-ups and reserve explicit steer
- [x] Expose mailbox positions and queued follow-up submission in the Web page
- [ ] Implement an explicit steer API/command with runtime capability negotiation
- [x] Renew leases during long turns and reconcile expired assignments/orphan containers
- [x] Persist authenticated supervisor registration, connection generations, and health expiry
- [x] Require owner-stop proof through a retryable cross-replica sandbox-retirement queue
- [x] Carry authenticated registration and shared heartbeats over a bounded outbound WebSocket
- [x] Route execute/cancel, two-phase command ACK/commit/result, and event publish/ACK over the remote supervisor connection
- [x] Automatically reconnect the same boot, drain old assignments, and resolve guarded remote backends per connection generation
- [x] Fence cross-instance execute/cancel claims to the current local socket owner without a second broker
- [x] Compose the shared event runtime, Supervisor gateway, bounded execute/cancel lanes, maintenance, and graceful drain
- [x] Replace the development bearer authorizer and owner boundary in the supported Docker topology with provisioned per-boot credentials and exact HTTP owner/inventory adapters
- [x] Compose a trusted Supervisor host with fresh boot identity, Docker ownership, S3 checkpoints, durable boot ledger, and active/quarantine event spool
- [x] Add pinned production images, persistent PostgreSQL/MinIO, private networks/secrets, Web ingress, health checks, and one-command deployment
- [x] Prove the production topology across control-plane reconnect/scale, Supervisor fresh boot/retirement, S3 restore, cancellation, secret audit, and cleanup
- [ ] Design mTLS/SPIFFE credentials for a multi-host or Kubernetes topology after that deployment target exists
