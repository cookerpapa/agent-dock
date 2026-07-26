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
- [x] Renew leases during long turns and reconcile expired assignments/orphan Provider runtimes
- [x] Persist authenticated supervisor registration, connection generations, and health expiry
- [x] Require owner-stop proof through a retryable cross-replica sandbox-retirement queue
- [x] Carry authenticated registration and shared heartbeats over a bounded outbound WebSocket
- [x] Route execute/cancel, two-phase command ACK/commit/result, and event publish/ACK over the remote supervisor connection
- [x] Automatically reconnect the same boot, drain old assignments, and resolve guarded remote backends per connection generation
- [x] Fence cross-instance execute/cancel claims to the current local socket owner without a second broker
- [x] Compose the shared event runtime, Supervisor gateway, bounded execute/cancel lanes, maintenance, and graceful drain
- [x] Replace the development bearer authorizer and owner boundary in the supported production topology with provisioned per-boot credentials and exact HTTP owner/inventory adapters
- [x] Compose a trusted Supervisor host with fresh boot identity, Provider ownership, S3 checkpoints, durable boot ledger, and active/quarantine event spool
- [x] Add pinned production images, persistent PostgreSQL/MinIO, private networks/secrets, Web ingress, health checks, and one-command deployment
- [x] Prove the production topology across control-plane reconnect/scale, Supervisor fresh boot/retirement, S3 restore, cancellation, secret audit, and cleanup
- [ ] Design mTLS/SPIFFE credentials for a future multi-host Kubernetes topology

## Trusted Pi Runner and remote Tool Sandbox slice (gVisor Tool history; superseded by ADR-0053)

- [x] ADR-0029: keep Pi/model auth trusted and route untrusted tools to a separate sandbox
- [x] Add closed Manager/tool-worker protocols with activation capabilities and exact assignment identity
- [x] Extract bounded workspace snapshot and Git-patch logic into a shared runtime package
- [x] Disable Pi built-in local tools and register remote read/write/edit/bash through Pi's public operations APIs
- [x] Give only the Sandbox Manager two namespace-scoped Roles plus one named RuntimeClass read; no application owns a Docker/containerd socket
- [x] Reserve tools logically, create no Pod for pure chat, and demand-activate one non-root, read-only, host-mount-free, default-deny gVisor Tool Pod on first use
- [x] Reuse a healthy Pod only for the exact tenant/project/workspace/session under a newer fence, with revision validation, Pod UID preconditions, idle TTL and bounded LRU eviction
- [x] Keep trusted root `AGENTS.md` instructions in the committed Workspace snapshot so Pi startup never performs an eager remote read
- [x] Separate settled Pi conversation checkpoints from Tool-triggered Workspace checkpoints
- [x] Coalesce adjacent text deltas and publish a bounded asynchronous event batch with cumulative durable ACK
- [x] Use a fixed credential-free subprocess environment and never forward Pi/model environment to bash
- [x] Keep the model gateway loopback-local to the trusted Runner and revoke turn capabilities on settlement
- [x] Route controlled GitHub imports through the Manager without giving the Manager repository-network membership
- [x] Add production secret migration, volume ownership bootstrap, health checks, images, and internal sandbox-control network
- [x] Prove real Pi `bash/edit` RPC, final diff/checkpoint, cancellation, cleanup, socket ownership, and secret absence
- [x] ADR-0030: separate Manager authorization/lifecycle from a provider-neutral SandboxProvider
- [x] Bind Provider handles to tenant, session, turn, attempt, lease, fence, and opaque runtime identity
- [x] Implement sole KubernetesGvisorSandboxProvider create/exec/read/write/snapshot/inspect/stop/destroy and orphan cleanup
- [x] Remove tenant/model Provider selection and lower-security fallback; reject unsupported non-deny-all Tool network policies
- [x] Add a live K3s/containerd/runsc KVM gate for guest identity, effective Pod policy/resources, `/proc`/credential isolation, cross-tenant workspaces, network denial, symlink/output bounds, cancellation, and exact cleanup
- [x] Publish the threat model, Provider contract, network matrix, and Run lifecycle
- [x] Add explicit tenant-scoped Run and immutable-numbered RunAttempt resources
- [x] Carry independent run/attempt identity through Supervisor and Provider boundaries
- [x] Persist claim, restore, run, checkpoint, heartbeat, failure, cancellation, and terminal history
- [x] Fence checkpoint and terminal writes by the current Attempt plus lease authority
- [x] Reconcile lost assignments by terminating the old Attempt before requeue/failure
- [ ] Isolate and policy-gate user/project Pi extensions before enabling discovery in production
- [x] Replace direct Docker lifecycle with mandatory Kubernetes RuntimeClass → gVisor/runsc KVM and remove all lower-security fallbacks
- [x] Remove the superseded Docker Sandboxes/LinuxKit Provider and legacy whole-Pi Docker execution path
- [x] Provision K3s/containerd, a fixed gVisor RuntimeClass, dedicated namespaces, Pod Security admission, scoped RBAC, and default-deny NetworkPolicy
- [x] Import the pinned Tool image into K3s as an operator action without exposing the containerd socket to an application
- [x] Route the internal Manager to the authenticated Kubernetes API through a credential-free fixed-target relay
- [x] Fence Pod assignment/deletion with tenant/session/Turn/Attempt annotations and Kubernetes UID preconditions
- [x] Prove full production restart/scale/backup recovery through the Kubernetes gVisor execution plane

## Primary CubeSandbox microVM Provider

- [x] Research TencentCloud/CubeSandbox v0.6.0 control, data, template,
  authentication, network and Kubernetes deployment contracts
- [x] ADR-0052: evaluate an operator-selected Cube KVM Provider behind
  `SandboxProvider`
- [x] Add a digest-pinned, credential-free Cube Tool template and prove its
  Tool protocol, fixed toolchain, traversal rejection and content checkpoint
  in a local compatibility gate
- [x] Add bounded CubeAPI/CubeProxy clients, private traffic-token routing,
  full assignment metadata/fencing checks, no-blind-replay behavior and exact
  lifecycle cleanup
- [x] Add fixed-target Compose relays and an operator deployment/rollback
  runbook without exposing a general egress proxy
- [x] Add a gated real-Cube acceptance test for two tenants, private/platform
  and public network denial, credential absence, cancellation and orphan
  inventory
- [x] ADR-0053: promote Cube to ordinary Tool execution, retain Pi/model state
  in the trusted Worker pool, and keep gVisor only for import/regression
- [x] Install the pinned local KVM plane, register a current-commit immutable
  template, and pass the real two-tenant/deny-all/cancellation/zero-orphan gate
- [x] Diagnose and enforce the WSL/K3s MTU path (`agentdock0=1500`,
  Flannel/Pod=1450) so CubeProxy responses cannot be black-holed
- [x] Make normal production commands fail closed on Cube cluster/template
  evidence and reserve stale-template tolerance only for inspection/teardown
- [x] ADR-0060: implement Cube's standard pause/connect recovery behind a
  sealed exact-Session handoff with Tool-process removal, higher fencing token,
  handoff-secret rotation and destroy-on-ambiguity fallback
- [x] Promote capability-scoped dependency setup from a disposable gVisor Pod
  into a newly created offline Cube guest without promoting processes, network
  state or credentials
- [ ] ADR-0062: enable full public Cube Tool egress while explicitly denying
  private/link-local/metadata/platform ranges and preserving private-token
  ingress
- [ ] Review Cube upgrade/node-loss drills and upstream state/idempotency issues
  before claiming a dedicated multi-node public deployment

## Controlled public GitHub workspace slice

- [x] ADR-0028: exact-commit public GitHub source and immutable seed boundary
- [x] Persist project, workspace, and tenant-scoped source metadata atomically
- [x] Restrict input to normalized `owner/repository` plus lowercase 40-hex commit SHA
- [x] Serialize concurrent first activations with an expiring PostgreSQL import lease
- [x] Reclaim expired leases and reject stale importer publication
- [x] Run Git in a one-shot credential-free, non-root, read-only gVisor importer Pod with narrowly allowed public-HTTPS egress
- [x] Disable redirects, hooks, credential helpers, submodules, LFS, external/file protocols, and interactive auth
- [x] Reuse the bounded regular-file workspace manifest and fail closed on unsupported repositories
- [x] Store a content-addressed immutable seed in S3 and verify key/hash/size/manifest on every activation
- [x] Establish the imported commit as the Tool Sandbox's Git baseline before overlaying a settled session checkpoint
- [x] Include tracked edits, deletions, and newly created files in the cumulative final patch
- [x] Add the Pi-export-inspired Web new-workspace panel and safe source status to conversation discovery
- [x] Prove two real Pi/DeepSeek turns reuse one seed, persist tool events/token usage, restore state, and leave no importer
- [ ] Add a DNS-aware repository egress proxy before claiming a mutually hostile public-tenant boundary
- [x] Add a trusted GitHub App credential boundary for private exact-commit import and Pull Request write-back
- [ ] Isolate and policy-gate project/user extensions before enabling them

## Phase 4 private multi-tenant slice

- [x] ADR-0025: private identity, roles, quotas, fair scheduling, and threat boundary
- [x] Store only indexed SHA-256 tenant credential digests and migrate the existing token unchanged
- [x] Add offline create/issue/list/revoke tenant administration
- [x] Derive every REST/SSE store scope from authenticated request identity
- [x] Return indistinguishable `404` responses for known foreign tenant UUIDs
- [x] Key process-local and PostgreSQL event wakes by tenant plus session
- [x] Enforce project, session, unsettled-turn, and concurrent-turn policy limits
- [x] Dispatch globally by least-recently-served tenant without breaking mailbox FIFO
- [x] Keep cancellation global and independent of normal tenant admission/fairness
- [x] Remove tenant identity and tenant API token from the running control-plane container
- [x] Show verified tenant/user/role in Web, retain token only in memory, and disable viewer writes
- [x] Prove two-tenant HTTP isolation, role denial, fair lanes, quota isolation, restart/scale, SSE, and S3 prefixes
- [x] Add opt-in anonymous tenant registration with bounded public admission
- [x] Add tenant-scoped conversation list/detail APIs and Web history switching
- [x] Add owner-only allowlisted model configuration and AES-GCM tenant credential versions
- [x] Add a Supervisor-only DeepSeek gateway with turn-scoped capabilities and internal-only worker networking
- [x] Run pinned Pi against a real provider, preserve checkpoints/diffs, and persist per-call tenant token usage
- [ ] Add public identity federation, billing, abuse controls, and a separate mutually hostile SaaS threat model
- [ ] Add measured warm-pool eviction if cold-start data justifies it
- [x] Add owner-priced cost accounting, per-Run request/tool/cost/time budgets,
  tenant-period token/cost quotas, and enforcement

## Cloud platform milestones 3–7

- [x] Add immutable Workspace history, compare, fork, rollback, archive, structured files/diff/tests/artifacts
- [x] Add trusted GitHub App Gateway contracts for private import and branch/commit/PR/Check delivery
- [x] Add context layers, Pi-native compaction audit, large-output artifacts,
  per-Run request/tool/cost budgets, and tenant-period token/cost quotas
- [x] Assign durable Run trace identities and propagate W3C context across trusted services
- [x] Export bearer-protected low-cardinality Prometheus metrics and redacted structured logs
- [x] Deploy persisted Prometheus, Jaeger, and provisioned Grafana behind loopback-only ingress
- [x] Expose an owner-only tenant operational summary without global metric access
- [x] Publish reproducible coding, fault, Sandbox security, and 10/50/100 HTTP load evaluations
- [x] Make gVisor/runsc KVM the sole validated Sandbox Provider and publish measured evidence
- [x] Expose Workspace files/history/compare/Artifacts, Runs/Attempts, tests, usage/context, and owner activity in the authenticated Web product
- [x] Expose fork/rollback/archive, retry-as-new-Run, GitHub App repository selection, and explicit PR delivery in the Web product
- [x] Add authenticated encrypted cold backup/restore for the runtime and all seven durable volumes
- [x] Prove restored tenant isolation, events, Workspace state, and continued execution in the disposable production gate
- [x] Add OCI revision labels, root/image CycloneDX SBOMs, complete HIGH/CRITICAL reports, and a fixable-HIGH/CRITICAL release gate
- [x] Pin third-party supply-chain Actions by immutable commit and publish a reproducible release-evidence command
- [x] Replace the operator-token landing page with persistent browser login/register and a conversation-first shell
- [x] Add an empty Workspace source for ordinary first-message conversation creation
- [x] Inherit and re-seal the platform default model for new accounts without exposing model controls or credentials
- [x] Restrict production model replacement to the platform operator tenant
- [x] Remediate Pi 0.80.10's shrinkwrap-pinned `brace-expansion@5.0.6` and `protobufjs@7.6.4` with exact reviewed package aliases, post-install replacement, actual-version checks in CI/production images, and an audit reconciler limited to the two exact advisory paths; keep the hardening fail-closed on any future Pi version until upstream republishes fixed metadata
- [x] Add append-only Project environment versions, immutable Run snapshots, Manager/image policy matching, in-gVisor Node/Java/Python/Git preflight, persisted environment evidence, exact-environment warm reuse, and Web validation status
- [x] Add declarative environment setup/verification recipes, immutable candidate history, fresh-gVisor validation, expected-active activation/rollback CAS, and actor audit
- [x] Add exact-commit multi-repository Workspaces with disjoint normalized roots and immutable Run source-set snapshots
- [x] Add per-environment dependency egress through an authenticated exact-host allowlist proxy, kill setup descendants, destroy the bootstrap Pod, and expose only a fresh never-networked gVisor Pod to Agent tools
- [x] Add single-consumption never-used gVisor prewarm Pods with measured cold-start evidence
- [x] Add Attempt supersession/rewind projections and immutable safe Review Bundles
- [x] Add reproducible Helm execution-plane packaging and failure/production acceptance evidence
- [x] Add transactionally materialized semantic Turn transcripts, legacy read repair, and active-suffix-only SSE hydration
- [x] Add a human-initiated Candidate Race from one immutable Workspace baseline
- [x] Fork 2–4 isolated child Sessions atomically and enforce a race-local concurrency cap in the tenant-fair dispatcher
- [x] Evaluate immutable Review Bundles with deterministic patch/test/path gates and an auditable scorecard
- [x] Add cancellation, a human decision gate, and parent Workspace-version CAS promotion without replacing parent Pi history
- [x] Expose candidate strategy, progress, evidence, recommendation, inspection, cancellation, and promotion in the authenticated Web inspector
- [ ] Add model-invoked recursive spawn/send/wait collaboration tools, inherited context modes, and tree budgets
- [ ] Add public identity, recovery, abuse controls, billing, and a separate hostile Internet-SaaS review before public exposure

## Durable orchestration and Pi checkpoint v2

- [x] Research mature durable workflow engines and conversation-storage
  patterns using official sources
- [x] ADR-0055: adopt-before-build policy, Temporal migration boundary, and
  content-addressed Pi segment manifests
- [x] Build an isolated pinned Temporal TypeScript spike with one Workflow per
  Run, two polling Pi Activity Workers, cancellation, heartbeat, retry/fence,
  service/Worker failure, history-secret scan, and rollback evidence
- [x] Record Temporal distribution/recovery latency and operational boundary;
  defer production cutover because the current Run maps to one long Activity
  and does not remove enough AgentDock protocol to justify another service
- [x] ADR-0056: accept Temporal as the sole post-admission scheduler after an
  explicit project-owner decision; retain PostgreSQL only for application
  admission, FIFO, attempts, leases/fences and commit correctness
- [x] Start one deterministic bounded-reference Workflow per Run, poll one
  common Task Queue from two capacity-bounded Pi Workers, and disable the
  superseded production WebSocket matching lanes
- [x] Route durable cancellation to the exact Workflow/Activity, heartbeat
  active work, and preserve ambiguous-side-effect fencing rather than claiming
  exactly-once execution
- [x] Deploy pinned self-hosted Temporal with internal-only networking,
  PostgreSQL persistence, namespace retention, readiness and coordinated cold
  backup/rollback documentation
- [x] Prove real-token pure-chat, multi-round Cube coding, cross-Worker Pi
  checkpoint recovery, two-Worker concurrency and secret-free Workflow history
- [x] Add Temporal Worker Build ID/versioning deployment gates before a
  multi-node rolling-upgrade claim
- [x] Implement `agent-dock.pi-session-manifest.v2` with line-aligned
  tenant-scoped content-addressed segments and S3 create-if-absent/checksums
- [x] Prove byte-identical v1/v2 restore, non-append rebase, corruption
  rejection, stale-fence inheritance, periodic consolidation, and local
  stored-byte/reconstruction benchmarks
- [ ] Add grace-period orphan GC plus remote MinIO p50/p95 and native
  compact/branch recovery through the production v2 object path
- [x] Benchmark direct Pi SDK activation against RPC without model tokens
- [x] Switch production to direct Pi SDK with capacity-one Worker replacement,
  instance-scoped remote-tool/model configuration, forced cancellation, native
  compaction, real-model, and credential-isolation parity
- [x] Add a bounded 10-minute per-Worker immutable checkpoint object cache
  without caching the PostgreSQL head, plus cache/restore metrics and a
  reproducible multi-tenant real-model load gate
- [x] Preserve capacity-one embedded Pi Worker failure domains while adding
  deployment-global FIFO CubeSandbox admission, cancellation-safe waiters and
  active/waiting/limit metrics
- [x] Add a closed Kubernetes StatefulSet Helm chart for capacity-one trusted
  Pi Workers with stable Supervisor identity, private boot/spool PVCs,
  per-Pod management routing and no runtime/Kubernetes authority
- [x] Keep conversation authority outside Worker Pods in PostgreSQL plus
  S3-compatible Pi-native checkpoints and document the recovery contract
- [x] Enable Temporal Worker Deployment name/Build ID and pinned Run Workflow
  routing in the Kubernetes profile
- [x] Document why Temporal Worker Controller is deferred while the private
  event spool requires stable per-replica storage
- [ ] Prove the Kubernetes Pi Worker chart on a real multi-node cluster with
  node loss, version ramp/rollback, external PostgreSQL/S3 failover and
  real-token concurrent Runs
- [x] Run the local single-node k3d Pi Worker cutover, real-token chat/Tool/
  restore/failover acceptance, and record measured evidence
- [x] Add capacity-aware same-Session Worker affinity with row-locked slot
  reservations, boot-specific Temporal Activity queues, a shared process-local
  capacity gate, short private-queue timeout and common-queue fallback
